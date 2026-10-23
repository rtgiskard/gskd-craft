import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { statisticsSnapshot } from "./skill-stats-core";

export interface ExportOptions {
	sourceDir: string;
	cwd: string;
	outputDir: string;
	all?: boolean;
	stats?: boolean;
	statsOnly?: boolean;
	/** Explicit host --session-dir, including directories outside the agent root. */
	sessionDir?: string;
	signal?: AbortSignal;
}

export interface ExportResult {
	archive?: string;
	files: number;
	message: string;
}

interface SourceFile { path: string; root: string; member: string; transcript?: boolean }
interface Session extends SourceFile { id: string; cwd: string; parent?: string }
interface InventoryFile { path: string; bytes: number; sha256: string }

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const codeIs = (error: unknown, code: string): boolean => (error as NodeJS.ErrnoException)?.code === code;
const within = (root: string, path: string): boolean => {
	const part = relative(root, path);
	return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
};

async function canonical(path: string): Promise<string> {
	try { return await realpath(path); }
	catch (error) {
		if (!codeIs(error, "ENOENT")) throw error;
		const absolute = resolve(path);
		const parent = dirname(absolute);
		return parent === absolute ? absolute : join(await canonical(parent), relative(parent, absolute));
	}
}

/** Never dereference links discovered inside an explicitly selected source root. */
async function assertContained(root: string, path: string): Promise<void> {
	if (!within(root, path)) throw new Error(`Export source escapes its root: ${path}`);
	let current = root;
	for (const part of relative(root, path).split(sep).filter(Boolean)) {
		current = join(current, part);
		if ((await lstat(current)).isSymbolicLink()) throw new Error(`Export refuses symbolic link: ${current}`);
	}
	if (!within(root, await realpath(path))) throw new Error(`Export source escapes its root: ${path}`);
}

/** Read only the bytes present at open, not an actively growing transcript's future tail. */
async function snapshot(file: SourceFile, signal?: AbortSignal): Promise<Buffer> {
	signal?.throwIfAborted();
	await assertContained(file.root, file.path);
	const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error(`Export source is not a regular file: ${file.path}`);
		const bytes = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < bytes.length) {
			signal?.throwIfAborted();
			const result = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!result.bytesRead) throw new Error(`Export source was truncated during snapshot: ${file.path}`);
			offset += result.bytesRead;
		}
		const after = await handle.stat();
		const current = await lstat(file.path);
		if (after.size < stat.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)
			|| current.ino !== stat.ino || current.dev !== stat.dev) {
			throw new Error(`Export source changed during snapshot; try again after writes settle: ${file.path}`);
		}
		await assertContained(file.root, file.path);
		if (!file.transcript) return bytes;
		// The host persists one newline-terminated event at a time. A partial last
		// write is not an event, even when its prefix happens to parse as JSON.
		const complete = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
		for (const line of complete.toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			try { JSON.parse(line); }
			catch { throw new Error(`Malformed complete JSONL event in ${file.path}`); }
		}
		return complete;
	} finally { await handle.close(); }
}

async function sessionHeader(file: SourceFile): Promise<Session | undefined> {
	await assertContained(file.root, file.path);
	const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		// Current host files start with an optional fixed-width title slot, then
		// the session header. Do not read unrelated projects' transcript bodies.
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const complete = buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, -1);
		for (const line of complete.slice(0, 2)) {
			let header: Record<string, unknown>;
			try { header = JSON.parse(line); } catch { continue; }
			if (header?.type !== "session") continue;
			if (typeof header.id !== "string" || typeof header.cwd !== "string") {
				throw new Error(`Invalid session header: ${file.path}`);
			}
			return { ...file, transcript: true, id: header.id, cwd: await canonical(header.cwd),
				parent: typeof header.parentSession === "string" ? header.parentSession : undefined };
		}
		return undefined;
	} finally { await handle.close(); }
}

/** Historical names are lineage keys, never paths to open or add to the archive. */
function historicalSessionPaths(header: Record<string, unknown>, file: SourceFile): string[] {
	if (!Array.isArray(header.previousSessionFiles)) return [];
	const paths = new Set<string>();
	for (const previous of header.previousSessionFiles) {
		// Host bucket moves retain the transcript filename. Ignore untrusted aliases
		// outside this selected storage root or belonging to another transcript.
		if (typeof previous !== "string" || !isAbsolute(previous) || basename(previous) !== basename(file.path)) continue;
		const path = resolve(previous);
		if (path !== file.root && within(file.root, path) && path.endsWith(".jsonl")) paths.add(path);
	}
	return [...paths];
}

async function discoverSessions(root: string, prefix: string, buckets: boolean): Promise<Session[]> {
	const sessions: Session[] = [];
	async function directory(path: string, descend: boolean): Promise<void> {
		let entries;
		try { entries = await readdir(path, { withFileTypes: true }); }
		catch (error) { if (codeIs(error, "ENOENT")) return; throw error; }
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const child = join(path, entry.name);
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const header = await sessionHeader({ path: child, root, member: `${prefix}/${relative(root, child).split(sep).join("/")}` });
				if (header) sessions.push(header);
			} else if (descend && entry.isDirectory()) {
				// Only project buckets here; child transcripts are captured with the
				// selected session's artifacts, not mistaken for project roots.
				try { await lstat(`${child}.jsonl`); }
				catch (error) { if (codeIs(error, "ENOENT")) { await directory(child, false); continue; } throw error; }
			} else if (entry.isSymbolicLink() && entry.name.endsWith(".jsonl")) {
				throw new Error(`Export refuses symbolic link: ${child}`);
			}
		}
	}
	await directory(root, buckets);
	return sessions;
}

async function collectFiles(sessions: Session[]): Promise<SourceFile[]> {
	const files = new Map<string, SourceFile>();
	async function artifacts(path: string, root: string, member: string): Promise<void> {
		let entries;
		try { await assertContained(root, path); entries = await readdir(path, { withFileTypes: true }); }
		catch (error) { if (codeIs(error, "ENOENT")) return; throw error; }
		for (const entry of entries) {
			// Host atomic-publish temporaries are dotfiles, not completed artifacts.
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const child = join(path, entry.name);
			const childMember = `${member}/${entry.name}`;
			if (entry.isSymbolicLink()) throw new Error(`Export refuses symbolic link: ${child}`);
			if (entry.isDirectory()) await artifacts(child, root, childMember);
			else if (entry.isFile()) {
				const file: SourceFile = { path: child, root, member: childMember };
				const session = child.endsWith(".jsonl") ? await sessionHeader(file) : undefined;
				files.set(child, session ?? file);
			}
			else throw new Error(`Export source is not a regular file: ${child}`);
		}
	}
	for (const session of sessions) {
		files.set(session.path, session);
		await artifacts(session.path.slice(0, -6), session.root, session.member.slice(0, -6));
	}
	return [...files.values()].sort((a, b) => a.member.localeCompare(b.member));
}

function blobReferences(bytes: Buffer): Set<string> {
	const hashes = new Set<string>();
	// References occur inside persisted JSON values, not arbitrary prose that
	// happens to mention the prefix. Source paths and file:// links are not read.
	const visit = (value: unknown): void => {
		if (typeof value === "string" && /^blob:sha256:[a-f0-9]{64}$/.test(value)) hashes.add(value.slice(12));
		else if (Array.isArray(value)) for (const item of value) visit(item);
		else if (value && typeof value === "object") for (const item of Object.values(value)) visit(item);
	};
	for (const line of bytes.toString("utf8").split("\n")) if (line.trim()) visit(JSON.parse(line));
	return hashes;
}

async function command(binary: string, args: string[], signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const { promise, resolve: accept, reject } = Promise.withResolvers<void>();
	const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], signal });
	let stderr = "";
	let failure: Error | undefined;
	child.stderr.on("data", chunk => { if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length); });
	child.once("error", error => { failure = codeIs(error, "ENOENT")
		? new Error(`Session export requires '${binary}' on PATH; install it before exporting.`) : error; });
	child.once("close", code => {
		if (failure) reject(failure);
		else if (code === 0) accept();
		else reject(new Error(`${binary} failed (${code}): ${stderr.trim()}`));
	});
	await promise;
}

/** Local snapshots of persisted sessions and optionally skill statistics. */
export async function exportSessions(options: ExportOptions): Promise<ExportResult> {
	const { signal } = options;
	const includeStats = options.stats || options.statsOnly;
	signal?.throwIfAborted();
	const source = await realpath(options.sourceDir);
	const cwd = await canonical(options.cwd);
	const sessionsRoot = join(source, "sessions");
	const custom = !options.statsOnly && options.sessionDir ? await realpath(options.sessionDir) : undefined;
	const external = custom && !within(sessionsRoot, custom) ? custom : undefined;
	const output = resolve(options.outputDir);
	// Staging must never become an artifact of the export currently being read.
	if (within(sessionsRoot, await canonical(output)) || (external && within(external, await canonical(output)))) {
		throw new Error("Export output directory must be outside session storage.");
	}
	let staging: string | undefined;
	try {
		const candidates = options.statsOnly ? [] : await discoverSessions(sessionsRoot, "sessions", true);
		if (custom && custom !== sessionsRoot) {
			const prefix = external ? `sessions-custom/${digest(external).slice(0, 12)}` : `sessions/${relative(sessionsRoot, custom).split(sep).join("/")}`;
			candidates.push(...await discoverSessions(custom, prefix, false));
		}
		const selected = candidates.filter(session => options.all || session.cwd === cwd);
		if (!selected.length && !includeStats) return { files: 0, message: "No sessions match the requested scope." };
		// Resolve descendants by either persisted parent ID or transcript path.
		const children = new Map<string, Session[]>();
		for (const session of candidates) {
			if (!session.parent) continue;
			for (const key of new Set([session.parent, resolve(session.parent)])) {
				const group = children.get(key);
				if (group) group.push(session);
				else children.set(key, [session]);
			}
		}
		const files: SourceFile[] = [];
		const collected = new Set<string>();
		async function enqueue(session: Session): Promise<void> {
			if (collected.has(session.path)) return;
			for (const file of await collectFiles([session])) {
				if (collected.has(file.path)) continue;
				collected.add(file.path);
				files.push(file);
			}
		}
		async function descendants(key: string): Promise<void> {
			const group = children.get(key);
			if (!group) return;
			children.delete(key);
			for (const session of group) await enqueue(session);
		}
		async function sourceSession(path: string): Promise<Session> {
			const root = within(sessionsRoot, path) ? sessionsRoot : external && within(external, path) ? external : undefined;
			if (!root || !path.endsWith(".jsonl")) throw new Error(`Seance source is outside available session storage: ${path}`);
			const prefix = root === sessionsRoot ? "sessions" : `sessions-custom/${digest(root).slice(0, 12)}`;
			// sessionHeader refuses symlinks and verifies containment before opening.
			const session = await sessionHeader({ path, root, member: `${prefix}/${relative(root, path).split(sep).join("/")}` });
			if (!session) throw new Error(`Invalid seance source session: ${path}`);
			return session;
		}
		for (const session of selected) await enqueue(session);
		await mkdir(output, { recursive: true, mode: 0o700 });
		staging = await mkdtemp(join(output, ".gskd-export-"));
		const payload = join(staging, "payload");
		await mkdir(payload, { mode: 0o700 });
		const inventory: InventoryFile[] = [];
		const blobs = new Set<string>();
		async function stageBytes(member: string, bytes: Buffer): Promise<void> {
			const sha256 = digest(bytes);
			if (member.startsWith("blobs/") && sha256 !== member.slice(6)) {
				throw new Error(`Referenced blob does not match its SHA-256 address: ${member}`);
			}
			inventory.push({ path: member, bytes: bytes.length, sha256 });
			const destination = join(payload, member);
			await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
			await writeFile(destination, bytes, { mode: 0o600 });
		}
		async function stage(file: SourceFile): Promise<void> {
			const bytes = await snapshot(file, signal);
			if (file.transcript) {
				for (const hash of blobReferences(bytes)) blobs.add(hash);
				for (const line of bytes.toString("utf8").split("\n").slice(0, 2)) {
					if (!line.trim()) continue;
					const header = JSON.parse(line);
					if (header?.type !== "session") continue;
					if (typeof header.id === "string") await descendants(header.id);
					await descendants(file.path);
					for (const path of historicalSessionPaths(header, file)) await descendants(path);
					if (typeof header.seanceSource !== "string") continue;
					const dependencyPath = resolve(header.seanceSource);
					if (!collected.has(dependencyPath)) await enqueue(await sourceSession(dependencyPath));
				}
			}
			await stageBytes(file.member, bytes);
		}
		for (const file of files) await stage(file);
		for (const hash of [...blobs].sort()) await stage({ path: join(source, "blobs", hash), root: source, member: `blobs/${hash}` });
		if (includeStats) {
			const database = join(source, "gskd-skill-insights.sqlite");
			// SQLite may read live sidecars. They must obey the same no-link source
			// boundary as the database; never copy the database or WAL as payloads.
			for (const path of [database, `${database}-wal`, `${database}-shm`]) {
				try {
					await assertContained(source, path);
					if (!(await lstat(path)).isFile()) throw new Error(`Export source is not a regular file: ${path}`);
				} catch (error) { if (!codeIs(error, "ENOENT")) throw error; }
			}
			signal?.throwIfAborted();
			// Statistics use the host's recorded cwd identity, which may be a symlink.
			const statistics = statisticsSnapshot(database, options.all ? undefined : options.cwd);
			await stageBytes("statistics.json", Buffer.from(JSON.stringify(statistics, null, 2) + "\n"));
		}
		const count = inventory.length;
		const created = new Date();
		const createdAt = created.toISOString();
		const pad = (value: number) => String(value).padStart(2, "0");
		const localTime = `${created.getFullYear()}${pad(created.getMonth() + 1)}${pad(created.getDate())}-${pad(created.getHours())}${pad(created.getMinutes())}${pad(created.getSeconds())}`;
		const batchId = randomBytes(4).toString("hex");
		await writeFile(join(payload, "manifest.json"), JSON.stringify({
			version: 1, batchId, createdAt,
			sourceDir: source, sessionDir: external, scope: options.all ? "all" : "project", cwd,
			snapshot: (options.statsOnly ? "" : "Session logs contain complete newline-terminated persisted events; ordinary artifacts retain their original bytes. In-flight unpersisted messages are not included.")
				+ (includeStats ? `${options.statsOnly ? "" : " "}Statistics contain persisted events from a logical database snapshot; no analysis was triggered.` : ""),
			files: inventory,
		}, null, 2) + "\n", { mode: 0o600 });
		// Separate processes give missing tar and missing zstd distinct dependency errors.
		const tar = join(staging, "snapshot.tar");
		const compressed = join(staging, "snapshot.tar.zst");
		await command("tar", ["-cf", tar, "-C", payload, "."], signal);
		await command("zstd", ["-q", "-f", tar, "-o", compressed], signal);
		signal?.throwIfAborted();
		await chmod(compressed, 0o600);
		const filename = `omp-export_${localTime}_${batchId}.tar.zst`;
		const archive = join(output, filename);
		signal?.throwIfAborted();
		await rename(compressed, archive);
		return { archive, files: count, message: `Exported ${count} files to ${archive}` };
	} finally {
		if (staging) await rm(staging, { recursive: true, force: true });
	}
}
