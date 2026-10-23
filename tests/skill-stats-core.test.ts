import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsStore, statisticsSnapshot, summarize, type StatsEvent } from "../extensions/skill-stats-core";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "gskd-skill-stats-test-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "agent", "gskd-skill-insights.sqlite");
	function open() {
		const store = new StatsStore(path);
		cleanups.push(() => store.close());
		return store;
	}
	return { root, path, open };
}

function event(id: string, extra: Partial<StatsEvent> = {}): StatsEvent {
	return {
		id, kind: "read", at: 1000, cwd: "/project", session: "session-main", agent: "Main", branch: "main",
		data: { skill: "gskd-review", source: "/skills/gskd-review/SKILL.md", file: "/skills/gskd-review/SKILL.md",
			section: "entry", range: "1-30", version: "sha256-of-returned-text", versionBasis: "returned-content", bytes: 42 },
		...extra,
	};
}

const candidate = { skill: "gskd-review", source: "/skills/gskd-review/SKILL.md", text: "Possibly missed a requirement",
	category: "correction", evidence: ["conversation-entry-1"], polarity: "problem", problem: "Unconfirmed model inference" };

describe("durable skill statistics", () => {
	test("persists full provenance and first-write-wins deduplication across reopen", async () => {
		const f = await fixture();
		const first = new StatsStore(f.path);
		const original = event("read-1", { branch: null, agent: "Child", data: {
			...event("template").data, childSession: "child", parentSession: "session-main", nested: { exact: [1, true, null] },
		} });
		try {
			first.record(original);
			first.record({ ...original, at: 99999, data: { replaced: true } });
			expect(first.events()).toEqual([original]);
		} finally { first.close(); }
		const reopened = f.open();
		reopened.record({ ...original, data: { replacedAfterRestart: true } });
		expect(reopened.events()).toEqual([original]);
		const copy = reopened.events();
		const nested = copy[0].data.nested;
		if (!nested || typeof nested !== "object" || !("exact" in nested) || !Array.isArray(nested.exact)) {
			throw new Error("Expected persisted nested test data");
		}
		nested.exact.push("local mutation");
		expect(reopened.events()).toEqual([original]);
	});

	test("deduplicates concurrent independent writers without dropping distinct events", async () => {
		const f = await fixture();
		const module = new URL("../extensions/skill-stats-core.ts", import.meta.url).href;
		const script = `
			import { StatsStore } from ${JSON.stringify(module)};
			const store = new StatsStore(process.argv[1]);
			try {
				for (let i = 0; i < 60; i++) {
					const shared = { id: "shared-" + i, kind: "read", at: i, cwd: "/project", session: "shared", agent: "Main", branch: null, data: { section: "entry" } };
					store.record(shared);
					store.record({ ...shared, id: process.argv[2] + "-" + i, session: process.argv[2] });
				}
			} finally { store.close(); }
		`;
		const workers = Array.from({ length: 4 }, (_, index) => Bun.spawn(
			[process.execPath, "--eval", script, f.path, `worker-${index}`], { stdout: "pipe", stderr: "pipe" },
		));
		const results = await Promise.all(workers.map(async worker => ({
			code: await worker.exited, stderr: await new Response(worker.stderr).text(),
		})));
		for (const result of results) expect(result).toEqual({ code: 0, stderr: "" });
		const stored = f.open().events();
		expect(stored).toHaveLength(300);
		expect(new Set(stored.map(item => item.id)).size).toBe(300);
		expect(stored.filter(item => item.id.startsWith("shared-"))).toHaveLength(60);
	}, 20000);

	test("filters exact cwd without prefix leakage and returns deterministic chronological order", async () => {
		const f = await fixture();
		const store = f.open();
		const records = [event("z", { at: 2000 }), event("b"), event("a"),
			event("nested", { cwd: "/project/subdirectory" }), event("other", { cwd: "/project-other" }),
			event("empty", { cwd: "" })];
		for (const item of records) store.record(item);
		expect(store.events("/project").map(item => item.id)).toEqual(["b", "a", "z"]);
		expect(store.events("").map(item => item.id)).toEqual(["empty"]);
		expect(store.events("/missing")).toEqual([]);
		expect(store.events()).toHaveLength(6);
	});

	test("resolves tied decisions by committed order across writers, reopen, legacy databases and snapshots", async () => {
		const f = await fixture();
		await mkdir(join(f.root, "agent"));
		const analysis = event("analysis", { kind: "analysis", data: {
			status: "completed", entryIds: ["entry#0", "entry#1"], candidates: [candidate,
				{ ...candidate, text: "Second candidate" }, { ...candidate, text: "Undecided candidate" }],
		} });
		const decision = (id: string, index: number, value: "confirm" | "reject", at = 2000) => event(id, {
			kind: "feedback", at, data: { origin: "model", candidateId: `analysis:${index}`, decision: value },
		});
		const first = decision("z-first-confirm", 0, "confirm");
		// Reproduce the pre-fix schema and data without relying on a migration.
		const legacy = new Database(f.path);
		try {
			legacy.exec(`CREATE TABLE events (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, at REAL NOT NULL,
				cwd TEXT NOT NULL, session TEXT NOT NULL, agent TEXT NOT NULL, branch TEXT, data TEXT NOT NULL)`);
			for (const item of [analysis, first]) legacy.query("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
				.run(item.id, item.kind, item.at, item.cwd, item.session, item.agent, item.branch, JSON.stringify(item.data));
		} finally { legacy.close(); }
		const writerA = new StatsStore(f.path);
		const writerB = new StatsStore(f.path);
		const rejected = decision("a-last-reject", 0, "reject");
		const rejectSecond = decision("zz-first-reject", 1, "reject");
		const confirmed = decision("aa-last-confirm", 1, "confirm");
		const stale = decision("stale", 1, "reject", 1500);
		try {
			writerB.record(rejected);
			writerB.record(rejectSecond);
			writerA.record(confirmed);
			writerA.record({ ...first, data: { ...first.data, decision: "confirm", unexpected: true } });
			writerB.record(stale);
		} finally { writerA.close(); writerB.close(); }
		const reopened = f.open();
		const expected = [analysis, stale, first, rejected, rejectSecond, confirmed];
		expect(reopened.events("/project")).toEqual(expected);
		const snapshot = JSON.parse(JSON.stringify(statisticsSnapshot(f.path, "/project")));
		expect(snapshot).toEqual({ version: 1, events: expected });
		for (const records of [reopened.events(), snapshot.events]) {
			const summary = summarize(records);
			expect(summary).toContain("Events: 6; unique sessions: 1");
			expect(summary).toContain("Explicit feedback: 0; model candidates: 3");
			expect(summary).toContain("Candidate decisions: 1 confirmed, 1 rejected, 1 unconfirmed");
			expect(summary).toContain("Candidate (rejected): Possibly missed a requirement");
			expect(summary).toContain("Candidate (confirmed): Second candidate");
			expect(summary).toContain("Candidate (unconfirmed): Undecided candidate");
			expect(summary).toContain("Analysis coverage: 2 conversation fragments covered by completed runs");
		}
	});

	test("persists settings independently from events and shares updates across connections", async () => {
		const f = await fixture();
		const first = new StatsStore(f.path);
		try {
			expect(first.getSetting("analysis.enabled")).toBeUndefined();
			first.setSetting("analysis.enabled", "false");
			first.setSetting("warning.shown", "true");
			expect(first.events()).toEqual([]);
		} finally { first.close(); }
		const second = f.open();
		const third = f.open();
		expect(second.getSetting("analysis.enabled")).toBe("false");
		expect(second.getSetting("warning.shown")).toBe("true");
		third.setSetting("analysis.enabled", "true");
		expect(second.getSetting("analysis.enabled")).toBe("true");
		second.setSetting("empty", "");
		expect(third.getSetting("empty")).toBe("");
	});

	test("preserves existing profile permissions while tightening database and WAL files", async () => {
		const f = await fixture();
		const directory = join(f.root, "agent");
		await mkdir(directory, { mode: 0o755 });
		await chmod(directory, 0o755);
		await writeFile(f.path, "", { mode: 0o666 });
		await chmod(f.path, 0o666);
		const store = f.open();
		store.record(event("private"));
		expect((await stat(directory)).mode & 0o777).toBe(0o755);
		for (const path of [f.path, f.path + "-wal", f.path + "-shm"]) {
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		}
		const db = new Database(f.path, { readonly: true });
		try { expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" }); }
		finally { db.close(); }
	});

	test("creates missing database directories privately", async () => {
		const f = await fixture();
		f.open().record(event("private"));
		expect((await stat(join(f.root, "agent"))).mode & 0o777).toBe(0o700);
	});

	test("propagates malformed databases rather than silently replacing or losing them", async () => {
		const f = await fixture();
		await mkdir(join(f.root, "agent"));
		const malformed = "this is not sqlite";
		await writeFile(f.path, malformed);
		expect(() => new StatsStore(f.path)).toThrow();
		expect(await readFile(f.path, "utf8")).toBe(malformed);
		expect(() => statisticsSnapshot(f.path)).toThrow();
	});

	test("refuses symlink database targets", async () => {
		const f = await fixture();
		await mkdir(join(f.root, "agent"));
		const target = join(f.root, "unrelated");
		await writeFile(target, "do not touch");
		await symlink(target, f.path);
		expect(() => new StatsStore(f.path)).toThrow();
		expect(() => statisticsSnapshot(f.path)).toThrow();
		expect(await readFile(target, "utf8")).toBe("do not touch");
	});
});

describe("read-only statistics snapshots", () => {
	test("returns a versioned empty snapshot without creating missing directories or files", async () => {
		const f = await fixture();
		expect(statisticsSnapshot(f.path)).toEqual({ version: 1, events: [] });
		expect(await readdir(f.root)).toEqual([]);
		await mkdir(join(f.root, "agent"));
		expect(statisticsSnapshot(f.path, "/project")).toEqual({ version: 1, events: [] });
		expect(await readdir(join(f.root, "agent"))).toEqual([]);
	});

	test("reads committed live WAL records, filters cwd, and preserves raw feedback and coverage", async () => {
		const f = await fixture();
		const store = f.open();
		const records = [event("read"), event("explicit", { kind: "feedback", at: 2000,
			data: { skill: "gskd-review", origin: "explicit", confirmed: true, text: "用户原话\nwithout redaction: secret", evidence: ["user-entry"] } }),
			event("analysis", { kind: "analysis", at: 3000, data: {
				status: "completed", entryIds: ["user-entry#0", "user-entry#1"], model: "provider/model", analyzerVersion: 1,
				fragments: [{ id: "user-entry#0", messageId: "user-entry", part: 0, parts: 2 },
					{ id: "user-entry#1", messageId: "user-entry", part: 1, parts: 2 }],
				coverage: { scope: "branch-message-fragments", from: "user-entry#0", through: "user-entry#1", truncated: false },
				candidates: [candidate], usage: { input: 20 },
			} }), event("other", { cwd: "/other" })];
		for (const item of records) store.record(item);
		store.setSetting("analysis.enabled", "false");
		const before = await readFile(f.path);
		expect(statisticsSnapshot(f.path)).toEqual({ version: 1, events: store.events() });
		expect(statisticsSnapshot(f.path, "/project")).toEqual({ version: 1, events: store.events("/project") });
		expect(statisticsSnapshot(f.path, "/other").events).toEqual([records[3]]);
		expect(statisticsSnapshot(f.path, "/absent")).toEqual({ version: 1, events: [] });
		expect(await readFile(f.path)).toEqual(before);
		expect(store.getSetting("analysis.enabled")).toBe("false");
	});
});

describe("source-grouped observational summary", () => {
	test("separates skill sources, entries and references, sessions, and last read", () => {
		const data = event("template").data;
		const summary = summarize([
			event("first"), event("reference", { at: 2000, data: { ...data, section: "reference", file: "/skills/gskd-review/references/details.md" } }),
			event("second-session", { at: 3000, session: "session-two", agent: "Child" }),
			event("different-source", { data: { ...data, source: "/another/gskd-review/SKILL.md" } }),
		]);
		expect(summary).toContain("gskd-review [/skills/gskd-review/SKILL.md]");
		expect(summary).toContain("gskd-review [/another/gskd-review/SKILL.md]");
		expect(summary).toContain("Reads: 2 entry, 1 reference; unique sessions: 2");
		expect(summary).toContain("Reads: 1 entry, 0 reference; unique sessions: 1");
		expect(summary).toContain("Last read: 1970-01-01T00:00:03.000Z");
		expect(summary).toContain("Repeated sessions: 1; repeat reads: 1");
		expect(summary).toContain("Reference: /skills/gskd-review/references/details.md; version: sha256-of-returned-text; reads: 1; returned bytes: 42");
		expect(summary).toContain("Entry: /skills/gskd-review/SKILL.md; version: sha256-of-returned-text; reads: 2; returned bytes: 84");
		expect(summary).toContain("Reads are observations, not evidence of skill success");
	});

	test("keeps explicit feedback and model candidates distinct and only uses completed analysis candidates", () => {
		const summary = summarize([
			event("read"), event("explicit", { kind: "feedback", data: { ...candidate, origin: "explicit", confirmed: true, text: "Actual user correction" } }),
			event("model", { kind: "feedback", data: { ...candidate, origin: "model", confirmed: false, text: "Standalone model candidate" } }),
			event("started", { kind: "analysis", data: { status: "started", entryIds: ["read"] } }),
			event("completed", { kind: "analysis", data: { status: "completed", entryIds: ["read", "conversation-entry-1"],
				coverage: { truncated: false }, candidates: [candidate] } }),
			event("failed", { kind: "analysis", data: { status: "failed", entryIds: ["uncovered"], candidates: [{ ...candidate, text: "Discard failed" }] } }),
			event("cancelled", { kind: "analysis", data: { status: "cancelled", entryIds: ["also-uncovered"], candidates: [{ ...candidate, text: "Discard cancelled" }] } }),
		]);
		expect(summary).toContain("Explicit feedback: 1; model candidates: 2");
		expect(summary).toContain("Explicit: Actual user correction");
		expect(summary).toContain("Candidate (unconfirmed): Standalone model candidate");
		expect(summary).toContain("Candidate (unconfirmed): Possibly missed a requirement");
		expect(summary).toContain("Evidence: conversation-entry-1");
		expect(summary).not.toContain("Discard failed");
		expect(summary).not.toContain("Discard cancelled");
		expect(summary).toContain("Analysis: 1 started, 1 completed, 1 failed, 1 cancelled");
		expect(summary).toContain("Analysis coverage: 2 conversation fragments covered by completed runs");
		expect(summary).toContain('Coverage detail: {"truncated":false}');
		expect(summary).toContain("model candidates are not explicit user feedback");
	});

	test("counts fragment coverage per session while deduplicating repeated analysis of the same session", () => {
		const completed = (id: string, session: string, entryIds: string[]) => event(id, {
			kind: "analysis", session, data: { status: "completed", entryIds },
		});
		const records = [
			completed("first", "session-one", ["entry#0", "entry#0", "entry#1"]),
			completed("repeated", "session-one", ["entry#0"]),
			completed("other-session", "session-two", ["entry#0"]),
		];
		expect(summarize(records.slice(0, 2))).toContain("Analysis coverage: 2 conversation fragments covered by completed runs");
		expect(summarize(records)).toContain("Analysis coverage: 3 conversation fragments covered by completed runs");
	});

	test("resolves the latest candidate decision without counting confirmations as new candidates", () => {
		const analysis = event("analysis", { kind: "analysis", at: 1000, data: {
			status: "completed", entryIds: ["message#0"], candidates: [candidate,
				{ ...candidate, text: "Rejected candidate" }, { ...candidate, text: "Undecided candidate" }],
		} });
		function decision(id: string, index: number, at: number, value: "confirm" | "reject") {
			return event(id, { kind: "feedback", at, data: { ...candidate, candidateId: `analysis:${index}`,
				origin: "model", confirmed: value === "confirm", decision: value } });
		}
		const summary = summarize([
			decision("confirm-first-again", 0, 4000, "confirm"),
			decision("reject-second", 1, 5000, "reject"),
			analysis,
			decision("confirm-first", 0, 3000, "confirm"),
			decision("confirm-second-stale", 1, 2000, "confirm"),
			decision("reject-nonexistent", 99, 6000, "reject"),
		]);
		expect(summary).toContain("Explicit feedback: 0; model candidates: 3");
		expect(summary).toContain("Candidate decisions: 1 confirmed, 1 rejected, 1 unconfirmed");
		expect(summary).toContain("Candidate (confirmed): Possibly missed a requirement");
		expect(summary).toContain("Candidate (rejected): Rejected candidate");
		expect(summary).toContain("Candidate (unconfirmed): Undecided candidate");
		expect(summary.match(/Candidate \(/g)).toHaveLength(3);
	});

	test("does not equate availability with a read or an unknown feedback origin with explicit input", () => {
		const summary = summarize([
			event("available", { kind: "availability", data: { skills: [{ name: "unused", source: "/unused/SKILL.md" }] } }),
			event("unknown-feedback", { kind: "feedback", data: { ...candidate, text: "Not attributed" } }),
		]);
		expect(summary).toContain("availability observations: 1");
		expect(summary).toContain("No skill reads or attributed feedback recorded.");
		expect(summary).not.toContain("Not attributed");
		expect(summary).not.toContain("unused [");
	});

	test("handles an empty log without claiming successful analysis", () => {
		const summary = summarize([]);
		expect(summary).toContain("Events: 0; unique sessions: 0");
		expect(summary).toContain("Analysis: 0 started, 0 completed, 0 failed, 0 cancelled");
		expect(summary).toContain("Analysis coverage: 0 conversation fragments covered by completed runs");
		expect(summary).toContain("No skill reads or attributed feedback recorded.");
	});
});
