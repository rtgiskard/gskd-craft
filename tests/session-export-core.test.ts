import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportSessions, type ExportOptions, type ExportResult } from "../extensions/session-export-core";

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
		expect(second.included).toEqual(["sessions/a/main.jsonl", "sessions/a/main/result.jsonl"]);
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
		expect(archive.included.sort()).toEqual(["sessions/a/main.jsonl", "sessions/b/main.jsonl"]);
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
		expect(archive.included.sort()).toEqual([member, "sessions/a/main.jsonl"].sort());
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
		expect(archive.included).toHaveLength(2);
		expect(archive.included.every(path => /^sessions-custom\/[a-f0-9]{12}\//.test(path))).toBe(true);
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

	test("empty scope and cancellation produce no archive", async () => {
		const f = await fixture();
		const result = await exportSessions(f.options);
		expect(result.files).toBe(0);
		expect(result.archive).toBeUndefined();
		await expect(exportSessions({ ...f.options, signal: AbortSignal.abort() })).rejects.toThrow();
		await expect(stat(f.options.outputDir)).rejects.toMatchObject({ code: "ENOENT" });
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
