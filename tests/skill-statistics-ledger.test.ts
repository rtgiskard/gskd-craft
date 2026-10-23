import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StatsStore, statisticsSnapshot, summarize, type StatsEvent } from "../extensions/skill-stats-core";

test("a hand-counted ledger reconciles reads, sources, sessions, decisions and coverage after reopen", async () => {
 const root = await mkdtemp(join(tmpdir(), "gskd-ledger-"));
 const path = join(root, "stats.sqlite");
 let store = new StatsStore(path);
 const base = { cwd: "/project", session: "s1", agent: "main", branch: "leaf" };
 const row = (id: string, kind: StatsEvent["kind"], at: number, data: Record<string, unknown>, extra = {}): StatsEvent => ({ ...base, id, kind, at, data, ...extra });
 const read = (id: string, at: number, bytes: number, section = "entry", source = "/one/SKILL.md", skill = "alpha", extra = {}) => row(id, "read", at, { skill, source, section, file: section === "entry" ? source : "/one/references/example.md", version: "v1", bytes }, extra);
 try {
  for (const event of [
   read("a", 1000, 40), read("a", 1000, 999), // The duplicate receipt must not add bytes or a read.
   read("b", 2000, 60), read("c", 3000, 20, "reference"), read("d", 4000, 80, "entry", "/one/SKILL.md", "alpha", { session: "s2" }),
   read("e", 4000, 10, "entry", "/two/SKILL.md", "alpha", { session: "s2" }),
   read("f", 4000, 30, "entry", "/beta/SKILL.md", "beta", { session: "s2" }),
   read("g", 4000, 70, "entry", "/one/SKILL.md", "alpha", { cwd: "/other", session: "s3" }),
  ]) store.record(event);
  const candidate = { skill: "alpha", text: "Scope correction", polarity: "correction", evidence: ["m#0"] };
  for (const event of [
   row("run-start", "analysis", 4100, { status: "started" }),
   row("analysis-a", "analysis", 4200, { status: "completed", entryIds: ["m#0", "m#1", "m#1"], candidates: [candidate, { ...candidate, text: "Second issue" }] }),
   row("analysis-b", "analysis", 4300, { status: "completed", entryIds: ["m#1", "m#2"], candidates: [] }),
   row("analysis-c", "analysis", 4400, { status: "completed", entryIds: ["m#0"], candidates: [{ ...candidate, text: "Independent session" }] }, { session: "s2" }),
   row("failed", "analysis", 4500, { status: "failed", entryIds: ["never-covered"] }),
   row("cancelled", "analysis", 4600, { status: "cancelled", entryIds: ["also-not-covered"] }),
   row("z-confirm", "feedback", 5000, { ...candidate, origin: "model", candidateId: "analysis-a:0", decision: "confirm" }),
   row("a-reject", "feedback", 5000, { ...candidate, origin: "model", candidateId: "analysis-a:0", decision: "reject" }),
   row("confirm-second", "feedback", 5001, { ...candidate, origin: "model", candidateId: "analysis-a:1", decision: "confirm" }),
   row("raw", "feedback", 5100, { skill: "alpha", source: "/one/SKILL.md", origin: "explicit", text: "first  line\n\tcode" }),
  ]) store.record(event);
  store.close(); store = new StatsStore(path);
  const project = store.events("/project");
  expect(project.filter(event => event.kind === "read")).toHaveLength(6);
  expect(store.events().filter(event => event.kind === "read")).toHaveLength(7);
  const reads = project.filter(event => event.kind === "read" && event.data.skill === "alpha" && event.data.source === "/one/SKILL.md");
  expect(reads.reduce((sum, event) => sum + Number(event.data.bytes), 0)).toBe(200);
  const output = summarize(project);
  expect(output).toContain("Reads: 3 entry, 1 reference; unique sessions: 2");
  expect(output).toContain("Repeated sessions: 1; repeat reads: 2");
  expect(output).toContain("alpha [/two/SKILL.md]");
  expect(output).toContain("Events: 16; unique sessions: 2;");
  expect(output).toContain("Analysis: 1 started, 3 completed, 1 failed, 1 cancelled");
  expect(output).toContain("Analysis coverage: 4 conversation fragments");
  expect(output).toContain("Candidate decisions: 1 confirmed, 1 rejected, 1 unconfirmed");
  expect(output).toContain("Explicit: first  line\n\tcode");
  const exported = summarize(statisticsSnapshot(path, "/project").events);
  expect(exported).toContain("Reads: 3 entry, 1 reference; unique sessions: 2");
  expect(exported).toContain("Analysis coverage: 4 conversation fragments");
  expect(exported).toContain("Candidate decisions: 1 confirmed, 1 rejected, 1 unconfirmed");
  expect(exported).toContain("Events: 16; unique sessions: 2;");
 } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
