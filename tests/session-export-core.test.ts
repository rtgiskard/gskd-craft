import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportSessions, type ExportOptions, type ExportResult } from "../extensions/session-export-core";
import { StatsStore, type StatsEvent } from "../extensions/skill-stats-core";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "gskd-export-test-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const options: ExportOptions = {
		sourceDir: join(root, "agent"), cwd: join(root, "project"),
		outputDir: join(root, "exports"),
	};
	await mkdir(join(options.sourceDir, "sessions"), { recursive: true });
	await mkdir(options.cwd);
	async function put(path: string, text: string | Buffer) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text);
	}
	async function session(member: string, cwd = options.cwd, extra: Record<string, unknown> = {}) {
		const path = join(options.sourceDir, "sessions", member);
		await put(path, JSON.stringify({ type: "title", title: "example", pad: " " }) + "\n"
			+ JSON.stringify({ type: "session", version: 3, id: member, cwd, ...extra }) + "\n"
			+ JSON.stringify({ type: "message", message: { role: "user", content: "original unredacted text" } }) + "\n");
		return path;
	}
	return { root, options, put, session };
}

function recordStatistics(sourceDir: string, events: StatsEvent[]): void {
	const store = new StatsStore(join(sourceDir, "gskd-skill-insights.sqlite"));
	cleanups.push(() => store.close());
	for (const event of events) store.record(event);
}

function statisticsEvents(cwd: string): StatsEvent[] {
	return [
		{ id: "read-1", kind: "read", at: 1, cwd, session: "session-1", agent: "Main", branch: null,
			data: { skill: "gskd-orient", path: "/skills/gskd-orient/SKILL.md", target: "entry" } },
		{ id: "analysis-1", kind: "analysis", at: 2, cwd, session: "session-1", agent: "Main", branch: "branch-1",
			data: { status: "completed", coverage: { from: "event-1", through: "event-7" }, candidates: [{ skill: "gskd-orient", text: "Possible improvement" }] } },
		{ id: "feedback-1", kind: "feedback", at: 3, cwd, session: "session-1", agent: "Main", branch: "branch-1",
			data: { skill: "gskd-orient", text: "Explicit feedback with raw /private/path and user@example.test" } },
	];
}

interface Manifest { files: Array<{ path: string; bytes: number; sha256: string }> }
async function unpack(result: ExportResult, root: string) {
	expect(result.archive).toBeDefined();
	const directory = await mkdtemp(join(root, "unpacked-"));
	execFileSync("tar", ["--zstd", "-xf", result.archive!, "-C", directory]);
	const manifest: Manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
	return { directory, manifest, included: manifest.files.map(file => file.path) };
}

describe("session export snapshot behavior", () => {
	test("selects project headers, nested children and artifacts, and only referenced blobs", async () => {
		const f = await fixture();
		const main = await f.session("encoded-project/main.jsonl");
		await f.session("collision/other.jsonl", join(f.root, "other-project"));
		await f.session("encoded-project/main/Child.jsonl", join(f.root, "isolated-worktree"), { parentSession: main });
		await f.session("encoded-project/main/Child/Nested.jsonl", join(f.root, "isolated-worktree"));
		await f.put(join(f.options.sourceDir, "sessions/encoded-project/main/3.bash.log"), "raw artifact");
		await f.put(join(f.options.sourceDir, "sessions/encoded-project/main/.partial.tmp"), "unfinished");
		const blob = Buffer.from("necessary image payload");
		const hash = createHash("sha256").update(blob).digest("hex");
		await appendFile(main, JSON.stringify({ type: "message", data: `blob:sha256:${hash}` }) + "\n");
		await f.put(join(f.options.sourceDir, "blobs", hash), blob);
		await f.put(join(f.options.sourceDir, "blobs", "f".repeat(64)), "unrelated blob");
		await f.put(join(f.options.sourceDir, "agent.db"), "credentials and settings");
		await f.put(join(f.options.sourceDir, "auth.json"), "secret");
		await f.put(join(f.options.cwd, "source.ts"), "project source");
		const result = await exportSessions(f.options);
		const archive = await unpack(result, f.root);
		expect(archive.included.sort()).toEqual([
			`blobs/${hash}`, "sessions/encoded-project/main.jsonl", "sessions/encoded-project/main/3.bash.log",
			"sessions/encoded-project/main/Child.jsonl", "sessions/encoded-project/main/Child/Nested.jsonl",
			"statistics.json",
		].sort());
		expect((await stat(result.archive!)).mode & 0o777).toBe(0o600);
		for (const item of archive.manifest.files) {
			const bytes = await readFile(join(archive.directory, item.path));
			expect(item.bytes).toBe(bytes.length);
			expect(item.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		}
	});

	test("repeated exports contain unchanged files and complete updated transcripts", async () => {
		const f = await fixture();
		const path = await f.session("a/main.jsonl");
		const original = await readFile(path);
		await f.put(join(f.options.sourceDir, "sessions/a/main/result.jsonl"), '{"value":"stable"}');
		const first = await unpack(await exportSessions(f.options), f.root);
		await appendFile(path, '{"type":"message","text":"next event"}\n');
		const second = await unpack(await exportSessions(f.options), f.root);
		expect(second.included).toEqual(["sessions/a/main.jsonl", "sessions/a/main/result.jsonl", "statistics.json"]);
		expect(await readFile(join(first.directory, "sessions/a/main.jsonl"))).toEqual(original);
		expect(await readFile(join(second.directory, "sessions/a/main.jsonl"))).toEqual(await readFile(path));
		expect(await readFile(join(second.directory, "sessions/a/main/result.jsonl"), "utf8")).toBe('{"value":"stable"}');
	});

	test("all captures other projects but never unrelated agent files", async () => {
		const f = await fixture();
		await f.session("a/main.jsonl");
		await f.session("b/main.jsonl", join(f.root, "another"));
		await f.put(join(f.options.sourceDir, "settings.json"), "secret");
		const archive = await unpack(await exportSessions({ ...f.options, all: true }), f.root);
		expect(archive.included.sort()).toEqual(["sessions/a/main.jsonl", "sessions/b/main.jsonl", "statistics.json"]);
	});

	test("captures cross-project descendants by persisted parent ID and necessary seance source", async () => {
		const f = await fixture();
		await f.session("a/main.jsonl", f.options.cwd, { id: "parent-id" });
		await f.session("b/child.jsonl", join(f.root, "another"), { parentSession: "parent-id" });
		const source = await f.session("c/source.jsonl", join(f.root, "third"));
		await f.session("a/seance.jsonl", f.options.cwd, { seanceSource: source });
		const archive = await unpack(await exportSessions(f.options), f.root);
		expect(archive.included).toContain("sessions/b/child.jsonl");
		expect(archive.included).toContain("sessions/c/source.jsonl");
	});

	test("captures descendants through prior bucket locations without reopening historical paths", async () => {
		const f = await fixture();
		const sessions = join(f.options.sourceDir, "sessions");
		const oldest = join(sessions, "oldest/main.jsonl");
		const previous = join(sessions, "previous/main.jsonl");
		await f.session("current/main.jsonl", f.options.cwd, {
			id: "parent-id", previousSessionFiles: [oldest, previous, oldest],
		});
		const other = join(f.root, "worktree");
		await f.session("oldest/child.jsonl", other, { parentSession: oldest });
		const oldChild = join(sessions, "previous/child.jsonl");
		const child = await f.session("current/child.jsonl", other, {
			parentSession: previous, previousSessionFiles: [oldChild],
		});
		await f.session("previous/grandchild.jsonl", other, { parentSession: oldChild });
		await f.put(child.slice(0, -6) + "/result.txt", "descendant artifact");
		await f.session("unrelated/main.jsonl", other);
		const archive = await unpack(await exportSessions(f.options), f.root);
		expect(archive.included.sort()).toEqual([
			"sessions/current/child.jsonl", "sessions/current/child/result.txt", "sessions/current/main.jsonl",
			"sessions/oldest/child.jsonl", "sessions/previous/grandchild.jsonl",
			"statistics.json",
		]);
		expect(await readFile(join(archive.directory, "sessions/current/child/result.txt"), "utf8")).toBe("descendant artifact");
	});

	test("ignores invalid historical aliases and never follows header paths outside selected storage", async () => {
		const f = await fixture();
		const sessions = join(f.options.sourceDir, "sessions");
		const outside = join(f.root, "outside/main.jsonl");
		const traversal = join(sessions, "..", "..", "escape", "main.jsonl");
		const wrongName = join(sessions, "old/not-main.jsonl");
		const relativePath = "relative/main.jsonl";
		await f.put(outside, "not a session, must never be opened\n");
		await f.session("current/main.jsonl", f.options.cwd, {
			previousSessionFiles: [outside, traversal, wrongName, relativePath, null, 7, {}],
		});
		for (const [index, parentSession] of [outside, traversal, wrongName, relativePath].entries()) {
			await f.session(`other/child-${index}.jsonl`, join(f.root, "other"), { parentSession });
		}
		const archive = await unpack(await exportSessions(f.options), f.root);
		expect(archive.included).toEqual(["sessions/current/main.jsonl", "statistics.json"]);
		expect(await readFile(outside, "utf8")).toBe("not a session, must never be opened\n");
	});

	test("resolves historical aliases within an explicitly selected custom session root", async () => {
		const f = await fixture();
		const sessionDir = join(f.root, "custom-sessions");
		const oldParent = join(sessionDir, "old/main.jsonl");
		await f.put(join(sessionDir, "main.jsonl"), JSON.stringify({
			type: "session", id: "custom-parent", cwd: f.options.cwd, previousSessionFiles: [oldParent],
		}) + "\n");
		await f.put(join(sessionDir, "child.jsonl"), JSON.stringify({
			type: "session", id: "custom-child", cwd: join(f.root, "other"), parentSession: oldParent,
		}) + "\n");
		const archive = await unpack(await exportSessions({ ...f.options, sessionDir }), f.root);
		const prefix = `sessions-custom/${createHash("sha256").update(sessionDir).digest("hex").slice(0, 12)}`;
		expect(archive.included.sort()).toEqual([`${prefix}/child.jsonl`, `${prefix}/main.jsonl`, "statistics.json"]);
	});

	test("nested sources and late descendants expand mixed links to a deduplicated closure", async () => {
		const f = await fixture();
		const other = join(f.root, "other");
		await f.session("b/parent.jsonl", other);
		const nested = await f.session("b/parent/child.jsonl", other, { id: "nested" });
		await f.put(join(f.options.sourceDir, "sessions/b/parent/child/result.txt"), "source artifact");
		const main = await f.session("a/main.jsonl", f.options.cwd, { seanceSource: nested });
		const last = await f.session("d/last.jsonl", other, { seanceSource: main });
		const branch = await f.session("c/branch.jsonl", other, { parentSession: "nested", seanceSource: last });
		await f.session("e/descendant.jsonl", other, { parentSession: branch });
		const archive = await unpack(await exportSessions(f.options), f.root);
		expect(archive.included.sort()).toEqual([
			"sessions/a/main.jsonl", "sessions/b/parent/child.jsonl", "sessions/b/parent/child/result.txt",
			"sessions/c/branch.jsonl", "sessions/d/last.jsonl", "sessions/e/descendant.jsonl",
			"statistics.json",
		]);
		expect(await readFile(join(archive.directory, "sessions/b/parent/child/result.txt"), "utf8")).toBe("source artifact");
	});

	test("resolves nested sources inside the explicit custom session root", async () => {
		const f = await fixture();
		const sessionDir = join(f.root, "custom");
		const nested = join(sessionDir, "parent/child.jsonl");
		await f.put(join(sessionDir, "parent.jsonl"), JSON.stringify({ type: "session", id: "parent", cwd: join(f.root, "other") }) + "\n");
		const content = JSON.stringify({ type: "session", id: "child", cwd: join(f.root, "other") }) + "\n";
		await f.put(nested, content);
		await f.session("a/main.jsonl", f.options.cwd, { seanceSource: nested });
		const archive = await unpack(await exportSessions({ ...f.options, sessionDir }), f.root);
		const member = `sessions-custom/${createHash("sha256").update(sessionDir).digest("hex").slice(0, 12)}/parent/child.jsonl`;
		expect(archive.included.sort()).toEqual([member, "sessions/a/main.jsonl", "statistics.json"].sort());
		expect(await readFile(join(archive.directory, member), "utf8")).toBe(content);
	});

	for (const kind of ["outside", "symlink", "invalid"] as const) {
		test(`rejects ${kind} seance sources without publishing an archive`, async () => {
			const f = await fixture();
			const outside = join(f.root, "outside.jsonl");
			await f.put(outside, JSON.stringify({ type: "session", id: "outside", cwd: f.options.cwd }) + "\n");
			const nested = join(f.options.sourceDir, "sessions/b/parent/child.jsonl");
			await f.session("b/parent.jsonl", join(f.root, "other"));
			await mkdir(dirname(nested), { recursive: true });
			if (kind === "symlink") await symlink(outside, nested);
			if (kind === "invalid") await f.put(nested, '{"result":"not a session"}\n');
			await f.session("a/main.jsonl", f.options.cwd, { seanceSource: kind === "outside" ? outside : nested });
			await expect(exportSessions(f.options)).rejects.toThrow(kind === "outside" ? "outside available session storage" : kind === "symlink" ? "symbolic link" : "Invalid seance source session");
			expect(await readdir(f.options.outputDir)).toEqual([]);
		});
	}

	test("supports an explicitly supplied custom host session directory", async () => {
		const f = await fixture();
		const sessionDir = join(f.root, "custom-sessions");
		await f.put(join(sessionDir, "custom.jsonl"), JSON.stringify({ type: "session", id: "custom", cwd: f.options.cwd }) + "\n");
		await f.put(join(sessionDir, "custom/result.md"), "child output");
		const archive = await unpack(await exportSessions({ ...f.options, sessionDir }), f.root);
		const prefix = `sessions-custom/${createHash("sha256").update(sessionDir).digest("hex").slice(0, 12)}`;
		expect(archive.included.sort()).toEqual([`${prefix}/custom.jsonl`, `${prefix}/custom/result.md`, "statistics.json"]);
		expect(await readFile(join(archive.directory, `${prefix}/custom/result.md`), "utf8")).toBe("child output");
	});

	test("all retains current custom sessions while adding other projects", async () => {
		const f = await fixture();
		await f.session("a/main.jsonl");
		await f.session("b/other.jsonl", join(f.root, "other-project"));
		const sessionDir = join(f.root, "custom-sessions");
		await f.put(join(sessionDir, "custom.jsonl"), JSON.stringify({ type: "session", id: "custom", cwd: f.options.cwd }) + "\n");
		const current = await unpack(await exportSessions({ ...f.options, sessionDir }), f.root);
		const all = await unpack(await exportSessions({ ...f.options, sessionDir, all: true }), f.root);
		expect(all.included.sort()).toEqual([...current.included, "sessions/b/other.jsonl"].sort());
	});

	test("ordinary JSONL artifacts remain byte-exact while child transcripts trim active tails", async () => {
		const f = await fixture();
		await f.session("a/main.jsonl");
		const child = await f.session("a/main/child.jsonl");
		const completeChild = await readFile(child);
		await appendFile(child, '{"type":"message"');
		const artifacts = { "result.jsonl": '{"result":"complete without newline"}', "raw.jsonl": 'tool output\nnot necessarily JSON', "refs.jsonl": JSON.stringify({ data: `blob:sha256:${"a".repeat(64)}` }) };
		for (const [name, content] of Object.entries(artifacts)) await f.put(join(f.options.sourceDir, "sessions/a/main", name), content);
		const archive = await unpack(await exportSessions(f.options), f.root);
		for (const [name, content] of Object.entries(artifacts)) expect(await readFile(join(archive.directory, "sessions/a/main", name), "utf8")).toBe(content);
		expect(await readFile(join(archive.directory, "sessions/a/main/child.jsonl"))).toEqual(completeChild);
	});

	test("snapshots only complete persisted events without altering source bytes", async () => {
		const f = await fixture();
		const path = await f.session("a/main.jsonl");
		const complete = await readFile(path);
		await appendFile(path, '{"type":"message","text":"part');
		const archive = await unpack(await exportSessions(f.options), f.root);
		expect(await readFile(join(archive.directory, "sessions/a/main.jsonl"))).toEqual(complete);
		expect((await readFile(path, "utf8")).endsWith('"part')).toBe(true);
	});

	test("does not silently skip a malformed complete event", async () => {
		const f = await fixture();
		await appendFile(await f.session("a/main.jsonl"), "not JSON\n");
		recordStatistics(f.options.sourceDir, statisticsEvents(f.options.cwd));
		await expect(exportSessions(f.options)).rejects.toThrow("Malformed complete JSONL event");
		expect((await readdir(f.options.outputDir)).filter(name => name.startsWith(".gskd-export-"))).toEqual([]);
	});

	test("rejects artifact symlink escape and output nested in source sessions", async () => {
		const f = await fixture();
		await f.session("a/main.jsonl");
		await f.put(join(f.root, "outside-secret"), "must not export");
		await mkdir(join(f.options.sourceDir, "sessions/a/main"));
		await symlink(join(f.root, "outside-secret"), join(f.options.sourceDir, "sessions/a/main/escape.log"));
		await expect(exportSessions(f.options)).rejects.toThrow("symbolic link");
		await expect(exportSessions({ ...f.options, outputDir: join(f.options.sourceDir, "sessions/a/output") })).rejects.toThrow("outside session storage");
	});

	test("missing referenced blobs fail rather than producing a claimed complete archive", async () => {
		const f = await fixture();
		const path = await f.session("a/main.jsonl");
		await appendFile(path, JSON.stringify({ type: "message", data: `blob:sha256:${"a".repeat(64)}` }) + "\n");
		await expect(exportSessions(f.options)).rejects.toThrow();
	});

	test("default export includes a hashed logical snapshot with recorded feedback", async () => {
		const f = await fixture();
		await f.session("a/main.jsonl");
		const events = statisticsEvents(f.options.cwd);
		recordStatistics(f.options.sourceDir, events);
		const result = await exportSessions(f.options);
		const archive = await unpack(result, f.root);
		expect(archive.included).toEqual(["sessions/a/main.jsonl", "statistics.json"]);
		expect(result.files).toBe(2);
		const bytes = await readFile(join(archive.directory, "statistics.json"));
		const statistics = JSON.parse(bytes.toString("utf8"));
		expect(statistics.version).toBe(1);
		expect(statistics.events).toEqual(events);
		expect(archive.manifest.files.find(file => file.path === "statistics.json")).toEqual({
			path: "statistics.json", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
		});
	});

	test("statistics archives retain complete events and committed tie order after reopen", async () => {
		const f = await fixture();
		const path = join(f.options.sourceDir, "gskd-skill-insights.sqlite");
		const analysis: StatsEvent = { id: "analysis", kind: "analysis", at: 1, cwd: f.options.cwd,
			session: "session", agent: "Main", branch: null, data: { status: "completed", entryIds: ["message#0"],
				candidates: [{ skill: "gskd-orient", source: "/skills/gskd-orient/SKILL.md", text: "Needs confirmation" }] } };
		const first: StatsEvent = { ...analysis, id: "z-first", kind: "feedback", at: 2,
			data: { origin: "model", candidateId: "analysis:0", decision: "confirm" } };
		const last: StatsEvent = { ...first, id: "a-last", data: { ...first.data, decision: "reject" } };
		const writerA = new StatsStore(path);
		const writerB = new StatsStore(path);
		try {
			writerA.record(analysis);
			writerA.record(first);
			writerB.record(last);
			writerB.record(first);
		} finally { writerA.close(); writerB.close(); }
		const archive = await unpack(await exportSessions({ ...f.options, statsOnly: true }), f.root);
		const statistics = JSON.parse(await readFile(join(archive.directory, "statistics.json"), "utf8"));
		expect(statistics.events).toEqual([analysis, first, last]);
	});

	test("stats-only ignores session storage and custom session paths", async () => {
		const f = await fixture();
		recordStatistics(f.options.sourceDir, statisticsEvents(f.options.cwd));
		await rm(join(f.options.sourceDir, "sessions"), { recursive: true });
		await symlink(join(f.root, "unavailable-sessions"), join(f.options.sourceDir, "sessions"));
		const result = await exportSessions({ ...f.options, statsOnly: true, sessionDir: join(f.root, "unavailable-custom-sessions") });
		const archive = await unpack(result, f.root);
		expect(archive.included).toEqual(["statistics.json"]);
		expect((await readdir(archive.directory)).sort()).toEqual(["manifest.json", "statistics.json"]);
		expect(result.files).toBe(1);
		expect((await stat(result.archive!)).mode & 0o777).toBe(0o600);
	});

	test("statistics obey project and all scopes from the explicit source root", async () => {
		const f = await fixture();
		const sourceDir = join(f.root, "explicit-agent");
		await mkdir(sourceDir);
		const project = statisticsEvents(f.options.cwd);
		const other: StatsEvent = { ...project[0]!, id: "other-read", cwd: join(f.root, "other-project") };
		recordStatistics(f.options.sourceDir, [{ ...project[0]!, id: "wrong-source" }]);
		recordStatistics(sourceDir, [...project, other]);
		const options = { ...f.options, sourceDir, statsOnly: true };
		const current = await unpack(await exportSessions(options), f.root);
		const all = await unpack(await exportSessions({ ...options, all: true }), f.root);
		expect(JSON.parse(await readFile(join(current.directory, "statistics.json"), "utf8")).events).toEqual(project);
		const allEvents: StatsEvent[] = JSON.parse(await readFile(join(all.directory, "statistics.json"), "utf8")).events;
		expect(allEvents).toHaveLength(project.length + 1);
		expect(allEvents).toEqual(expect.arrayContaining([...project, other]));
		expect(current.included).toEqual(["statistics.json"]);
		expect(all.included).toEqual(["statistics.json"]);
	});

	for (const statsOnly of [false, true]) {
		test(`${statsOnly ? "stats-only" : "default"} retains statistics recorded under a symlink cwd`, async () => {
			const f = await fixture();
			const cwd = join(f.root, "linked-project");
			await symlink(f.options.cwd, cwd);
			await f.session("a/main.jsonl", cwd);
			const events = statisticsEvents(cwd);
			recordStatistics(f.options.sourceDir, events);
			const archive = await unpack(await exportSessions({ ...f.options, cwd, statsOnly }), f.root);
			expect(JSON.parse(await readFile(join(archive.directory, "statistics.json"), "utf8")).events).toEqual(events);
			expect(archive.included).toEqual(statsOnly ? ["statistics.json"] : ["sessions/a/main.jsonl", "statistics.json"]);
		});
	}

	test("missing statistics leave no database or empty archive", async () => {
		const f = await fixture();
		await rm(join(f.options.sourceDir, "sessions"), { recursive: true });
		const result = await exportSessions({ ...f.options, statsOnly: true });
		expect(result.archive).toBeUndefined();
		expect(result.files).toBe(0);
		expect(await readdir(f.options.sourceDir)).toEqual([]);
		expect(await readdir(f.options.outputDir)).toEqual([]);
	});

	test("default export retains statistics when no sessions match", async () => {
		const f = await fixture();
		await f.session("other/main.jsonl", join(f.root, "other-project"));
		recordStatistics(f.options.sourceDir, statisticsEvents(f.options.cwd));
		const archive = await unpack(await exportSessions(f.options), f.root);
		expect(archive.included).toEqual(["statistics.json"]);
	});

	test("corrupt statistics warn without losing sessions or publishing a stats-only archive", async () => {
		const f = await fixture();
		const session = await f.session("a/main.jsonl");
		const database = join(f.options.sourceDir, "gskd-skill-insights.sqlite");
		await f.put(database, "corrupt database");
		const result = await exportSessions(f.options);
		const archive = await unpack(result, f.root);
		expect(archive.included).toEqual(["sessions/a/main.jsonl"]);
		expect(await readFile(join(archive.directory, "sessions/a/main.jsonl"))).toEqual(await readFile(session));
		expect(result.warnings).toEqual([expect.stringContaining("Statistics omitted:")]);
		expect(JSON.parse(await readFile(join(archive.directory, "manifest.json"), "utf8")).warnings).toEqual(result.warnings);
		expect(await readFile(database, "utf8")).toBe("corrupt database");
		const empty = await exportSessions({ ...f.options, statsOnly: true });
		expect(empty.archive).toBeUndefined();
		expect(empty.warnings).toEqual(result.warnings);
		expect(await readdir(f.options.outputDir)).toEqual([result.archive!.split("/").at(-1)!]);
	});

	for (const suffix of ["", "-wal", "-shm"]) {
		test(`statistics warn about a linked database${suffix} while retaining session files`, async () => {
			const f = await fixture();
			await f.session("a/main.jsonl");
			const outside = join(f.root, "outside-statistics");
			await f.put(outside, "not an export source");
			await symlink(outside, join(f.options.sourceDir, `gskd-skill-insights.sqlite${suffix}`));
			const result = await exportSessions(f.options);
			const archive = await unpack(result, f.root);
			expect(archive.included).toEqual(["sessions/a/main.jsonl"]);
			expect(result.warnings[0]).toContain("symbolic link");
			expect(JSON.parse(await readFile(join(archive.directory, "manifest.json"), "utf8")).warnings).toEqual(result.warnings);
			const empty = await exportSessions({ ...f.options, statsOnly: true });
			expect(empty.archive).toBeUndefined();
			expect(empty.warnings[0]).toContain("symbolic link");
			expect(await readdir(f.options.outputDir)).toEqual([result.archive!.split("/").at(-1)!]);
		});
	}

	test("stats-only retains output containment and cancellation protections", async () => {
		const f = await fixture();
		await expect(exportSessions({ ...f.options, statsOnly: true, outputDir: join(f.options.sourceDir, "sessions/export") })).rejects.toThrow("outside session storage");
		await expect(exportSessions({ ...f.options, statsOnly: true, signal: AbortSignal.abort() })).rejects.toThrow();
		expect(await readdir(f.options.sourceDir)).toEqual(["sessions"]);
	});

	test("empty scope publishes no archive and cancellation remains effective", async () => {
		const f = await fixture();
		const result = await exportSessions(f.options);
		expect(result.archive).toBeUndefined();
		expect(result.files).toBe(0);
		expect(result.message).toContain("No session files or statistics");
		await expect(exportSessions({ ...f.options, signal: AbortSignal.abort() })).rejects.toThrow();
		expect(await readdir(f.options.outputDir)).toEqual([]);
	});

	test("reports missing tar and zstd separately and removes incomplete staging", async () => {
		const f = await fixture();
		await f.session("a/main.jsonl");
		const tools = join(f.root, "tools");
		await mkdir(tools);
		const tar = Bun.which("tar");
		expect(tar).not.toBeNull();
		const oldPath = process.env.PATH;
		try {
			process.env.PATH = tools;
			await expect(exportSessions(f.options)).rejects.toThrow("requires 'tar' on PATH");
			await symlink(tar!, join(tools, "tar"));
			await expect(exportSessions(f.options)).rejects.toThrow("requires 'zstd' on PATH");
		} finally {
			if (oldPath === undefined) delete process.env.PATH;
			else process.env.PATH = oldPath;
		}
		expect(await readdir(f.options.outputDir)).toEqual([]);
	});
});
