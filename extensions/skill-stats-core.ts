import { Database } from "bun:sqlite";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export type StatsEvent = {
	id: string;
	kind: "read" | "availability" | "feedback" | "analysis";
	at: number;
	cwd: string;
	session: string;
	agent: string;
	branch: string | null;
	data: Record<string, unknown>;
};

type EventRow = Omit<StatsEvent, "data"> & { data: string };
export interface StatisticsSnapshot { version: 1; events: StatsEvent[] }

const eventColumns = "id, kind, at, cwd, session, agent, branch, data";

// Existing events tables already persist insertion order in SQLite's rowid.
// Retain that order for timestamp ties in both live reads and exported snapshots.
function readEvents(db: Database, cwd?: string): StatsEvent[] {
	const rows = cwd === undefined
		? db.query<EventRow, []>(`SELECT ${eventColumns} FROM events ORDER BY at, rowid`).all()
		: db.query<EventRow, [string]>(`SELECT ${eventColumns} FROM events WHERE cwd = ? ORDER BY at, rowid`).all(cwd);
	return rows.map(row => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
}

/** A shared durable log: deduplication belongs to SQLite, not a process-local cache. */
export class StatsStore {
	private readonly db: Database;

	constructor(path: string) {
		const directory = dirname(path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		// Create privately before SQLite can open the database or its WAL sidecars.
		const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
		try {
			if (!fstatSync(fd).isFile()) throw new Error(`Statistics database is not a regular file: ${path}`);
			fchmodSync(fd, 0o600);
		} finally { closeSync(fd); }
		const db = new Database(path, { readwrite: true, create: false });
		try {
			db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
			db.exec(`
				CREATE TABLE IF NOT EXISTS events (
					id TEXT PRIMARY KEY NOT NULL,
					kind TEXT NOT NULL CHECK (kind IN ('read', 'availability', 'feedback', 'analysis')),
					at REAL NOT NULL,
					cwd TEXT NOT NULL,
					session TEXT NOT NULL,
					agent TEXT NOT NULL,
					branch TEXT,
					data TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS events_cwd_at ON events (cwd, at, id);
				CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
			`);
			// SQLite inherits database permissions for newly created WAL/SHM files;
			// also tighten sidecars left by an older, less-private writer.
			for (const suffix of ["-wal", "-shm"]) {
				try { chmodSync(path + suffix, 0o600); }
				catch (error) {
					if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
				}
			}
			this.db = db;
		} catch (error) { db.close(); throw error; }
	}

	close(): void { this.db.close(); }

	record(event: StatsEvent): void {
		this.db.query(`INSERT INTO events (${eventColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO NOTHING`).run(event.id, event.kind, event.at, event.cwd,
			event.session, event.agent, event.branch, JSON.stringify(event.data));
	}

	events(cwd?: string): StatsEvent[] { return readEvents(this.db, cwd); }

	getSetting(key: string): string | undefined {
		return this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value;
	}

	setSetting(key: string, value: string): void {
		this.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
			.run(key, value);
	}
}

/** Query the live WAL through SQLite; never create a missing source or copy DB files. */
export function statisticsSnapshot(path: string, cwd?: string): StatisticsSnapshot {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Statistics database is not a regular file: ${path}`);
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return { version: 1, events: [] };
		throw error;
	}
	const db = new Database(path, { readonly: true, create: false });
	try {
		db.exec("PRAGMA busy_timeout = 5000;");
		return { version: 1, events: readEvents(db, cwd) };
	} finally { db.close(); }
}

type Feedback = { id?: string; text: string; state: "confirmed" | "rejected" | "unconfirmed"; evidence: string[] };
type SkillGroup = {
	skill: string;
	source: string;
	entries: number;
	references: number;
	sessions: Map<string, number>;
	files: Map<string, { file: string; version: string; section: string; reads: number; bytes: number }>;
	lastRead?: number;
	explicit: Feedback[];
	candidates: Feedback[];
};

/** Observed reads and attributed feedback only; read counts are not success scores. */
export function summarize(events: StatsEvent[]): string {
	const groups = new Map<string, SkillGroup>();
	const sessions = new Set<string>();
	const covered = new Set<string>();
	const statuses = { started: 0, completed: 0, failed: 0, cancelled: 0 };
	const coverage: string[] = [];
	const decisions = new Map<string, { at: number; state: "confirmed" | "rejected" }>();
	const candidateIds = new Set<string>();
	let availability = 0;
	function group(data: Record<string, unknown>): SkillGroup | undefined {
		if (typeof data.skill !== "string" || !data.skill) return undefined;
		const source = typeof data.source === "string" ? data.source : "unknown source";
		const key = JSON.stringify([data.skill, source]);
		let value = groups.get(key);
		if (!value) {
			value = { skill: data.skill, source, entries: 0, references: 0, sessions: new Map(), files: new Map(), explicit: [], candidates: [] };
			groups.set(key, value);
		}
		return value;
	}
	function feedback(data: Record<string, unknown>, explicit: boolean, id?: string): void {
		if (!explicit && id && candidateIds.has(id)) return;
		const target = group(data);
		if (!target || typeof data.text !== "string") return;
		const item: Feedback = { id, text: data.text, state: "unconfirmed",
			evidence: Array.isArray(data.evidence) ? data.evidence.filter((value): value is string => typeof value === "string") : [] };
		if (!explicit && id) candidateIds.add(id);
		(explicit ? target.explicit : target.candidates).push(item);
	}
	for (const event of events) {
		sessions.add(event.session);
		if (event.kind === "read") {
			const target = group(event.data);
			if (!target) continue;
			if (event.data.section === "entry") target.entries++;
			else if (event.data.section === "reference") target.references++;
			target.sessions.set(event.session, (target.sessions.get(event.session) ?? 0) + 1);
			if (typeof event.data.file === "string") {
				const version = typeof event.data.version === "string" ? event.data.version : "unknown version";
				const section = event.data.section === "reference" ? "Reference" : "Entry";
				const key = JSON.stringify([event.data.file, version, section]);
				let file = target.files.get(key);
				if (!file) {
					file = { file: event.data.file, version, section, reads: 0, bytes: 0 };
					target.files.set(key, file);
				}
				file.reads++;
				if (typeof event.data.bytes === "number" && Number.isFinite(event.data.bytes) && event.data.bytes >= 0) file.bytes += event.data.bytes;
			}
			target.lastRead = Math.max(target.lastRead ?? -Infinity, event.at);
		} else if (event.kind === "feedback") {
			if (event.data.origin === "model" && typeof event.data.candidateId === "string"
				&& (event.data.decision === "confirm" || event.data.decision === "reject")) {
				const previous = decisions.get(event.data.candidateId);
				if (!previous || event.at >= previous.at) {
					decisions.set(event.data.candidateId, { at: event.at,
						state: event.data.decision === "confirm" ? "confirmed" : "rejected" });
				}
			} else if (event.data.origin === "explicit" || event.data.origin === "model") {
				feedback(event.data, event.data.origin === "explicit",
					typeof event.data.candidateId === "string" ? event.data.candidateId : event.id);
			}
		} else if (event.kind === "availability") availability++;
		else if (event.kind === "analysis") {
			const status = event.data.status;
			if (typeof status === "string" && Object.hasOwn(statuses, status)) statuses[status as keyof typeof statuses]++;
			if (status !== "completed") continue;
			if (Array.isArray(event.data.entryIds)) {
				for (const id of event.data.entryIds) if (typeof id === "string") covered.add(JSON.stringify([event.session, id]));
			}
			if (event.data.coverage !== undefined) coverage.push(JSON.stringify(event.data.coverage));
			if (Array.isArray(event.data.candidates)) {
				for (const [index, candidate] of event.data.candidates.entries()) {
					if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
						feedback(candidate as Record<string, unknown>, false, `${event.id}:${index}`);
					}
				}
			}
		}
	}
	const lines = ["Skill insights", `Events: ${events.length}; unique sessions: ${sessions.size}; availability observations: ${availability}`,
		`Analysis: ${statuses.started} started, ${statuses.completed} completed, ${statuses.failed} failed, ${statuses.cancelled} cancelled`,
		`Analysis coverage: ${covered.size} conversation fragments covered by completed runs`];
	for (const detail of coverage) lines.push(`Coverage detail: ${detail}`);
	if (!groups.size) lines.push("No skill reads or attributed feedback recorded.");
	for (const item of [...groups.values()].sort((a, b) => a.skill.localeCompare(b.skill) || a.source.localeCompare(b.source))) {
		const counts = { confirmed: 0, rejected: 0, unconfirmed: 0 };
		for (const value of item.candidates) {
			if (value.id) value.state = decisions.get(value.id)?.state ?? "unconfirmed";
			counts[value.state]++;
		}
		let repeatedSessions = 0;
		let repeatReads = 0;
		for (const count of item.sessions.values()) {
			if (count > 1) { repeatedSessions++; repeatReads += count - 1; }
		}
		lines.push("", `${item.skill} [${item.source}]`,
			`  Reads: ${item.entries} entry, ${item.references} reference; unique sessions: ${item.sessions.size}`,
			`  Last read: ${item.lastRead === undefined ? "never" : new Date(item.lastRead).toISOString()}`,
			`  Explicit feedback: ${item.explicit.length}; model candidates: ${item.candidates.length}`);
		lines.push(`  Repeated sessions: ${repeatedSessions}; repeat reads: ${repeatReads}`,
			`  Candidate decisions: ${counts.confirmed} confirmed, ${counts.rejected} rejected, ${counts.unconfirmed} unconfirmed`);
		for (const file of [...item.files.values()].sort((a, b) => a.file.localeCompare(b.file) || a.version.localeCompare(b.version))) {
			lines.push(`  ${file.section}: ${file.file}; version: ${file.version}; reads: ${file.reads}; returned bytes: ${file.bytes}`);
		}
		for (const value of item.explicit) lines.push(`  Explicit: ${value.text}`);
		for (const value of item.candidates) {
			lines.push(`  Candidate (${value.state}): ${value.text}`);
			if (value.evidence.length) lines.push(`    Evidence: ${value.evidence.join(", ")}`);
		}
	}
	lines.push("", "Reads are observations, not evidence of skill success; model candidates are not explicit user feedback.");
	return lines.join("\n");
}
