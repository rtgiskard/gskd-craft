import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("SDK feedback commands preserve canonical decisions, ledger order and raw feedback", async () => {
	const root = await mkdtemp(join(tmpdir(), "gskd-insights-decision-"));
	try {
		// A separate process keeps the SDK profile environment isolated from other tests.
		const script = `
import assert from "node:assert/strict";
import { createAgentSession, SessionManager, Settings, AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import insights from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../extensions/skill-insights.ts")).href)};
import { StatsStore } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../extensions/skill-stats-core.ts")).href)};
const root = process.env.REVIEW_PROJECT;
const agentDir = process.env.PI_CODING_AGENT_DIR;
const store = new StatsStore(agentDir + "/gskd-skill-insights.sqlite");
store.setSetting("analysis.enabled", "false");
const manager = SessionManager.inMemory(root);
const { session } = await createAgentSession({ cwd: root, agentDir, sessionManager: manager, settings: Settings.isolated({ "memory.backend": "off", "memories.enabled": false, "telemetry.otlpExportEnabled": false }), agentRegistry: new AgentRegistry(), bindProcessState: false, hasUI: false, cacheWarming: false, autoTitle: false, enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true, toolNames: [], skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [], preloadedCustomToolPaths: [], disableExtensionDiscovery: true, extensions: [insights] });
const notices = []; const noticeTypes = []; const errors = [];
try {
 assert(session.extensionRunner);
 await initializeExtensions(session, { mode: "rpc", uiContext: { ...session.extensionRunner.getUIContext(), notify: (text, type) => { notices.push(text); noticeTypes.push(type); } }, reportRuntimeError: error => errors.push(error), reportSendError: (_action, error) => errors.push(error) });
 assert.deepEqual(noticeTypes, ["info"]);
 assert.equal(store.getSetting("analysis.enabled"), "false");
 assert.equal(store.getSetting("analysis.notice"), "1");
 const base = { cwd: root, session: manager.getSessionId(), agent: "main:main", branch: null };
 const candidate = { skill: "review", text: "Discuss before implementing", category: "execution", polarity: "correction", evidence: ["entry#0"] };
 store.record({ ...base, id: "analysis-example", kind: "analysis", at: 1000, data: { status: "completed", candidates: [candidate, { ...candidate, text: "Keep unrelated settings unchanged" }] } });
 store.record({ ...base, id: "prior-confirmation", kind: "feedback", at: 1001, data: { ...candidate, origin: "model", candidateId: "analysis-example:1", decision: "confirm", confirmed: true } });
 for (const [command, candidateId, decision] of [
  ["feedback confirm analysis-example:00", "analysis-example:0", "confirm"],
  ["feedback reject analysis-example:001", "analysis-example:1", "reject"],
  ["feedback confirm analysis-example:0", "analysis-example:0", "confirm"],
  ["feedback reject analysis-example:1", "analysis-example:1", "reject"],
 ]) {
  const before = new Set(store.events(root).map(row => row.id));
  await session.prompt("/gskd-insights " + command);
  const added = store.events(root).filter(row => row.kind === "feedback" && !before.has(row.id));
  assert.deepEqual(added.map(row => ({ candidateId: row.data.candidateId, decision: row.data.decision })), [{ candidateId, decision }]);
 }
 // Equal timestamps are ordered by their durable receipt order, never UUID spelling.
 const decisionAt = Date.now() + 1000;
 store.record({ ...base, id: "z-confirmation", kind: "feedback", at: decisionAt, data: { ...candidate, origin: "model", candidateId: "analysis-example:1", decision: "confirm", confirmed: true } });
 store.record({ ...base, id: "a-rejection", kind: "feedback", at: decisionAt, data: { ...candidate, origin: "model", candidateId: "analysis-example:1", decision: "reject", confirmed: false } });
 await session.prompt("/gskd-insights review");
 const summary = notices.at(-1);
 assert(summary.includes("1 confirmed, 1 rejected, 0 unconfirmed"), summary);
 assert(summary.includes("model candidates: 2"), summary);
 const decisions = store.events(root).filter(row => row.kind === "feedback");
 assert(decisions.every(row => ["analysis-example:0", "analysis-example:1"].includes(row.data.candidateId)));
 store.record({ ...base, id: "mixed-skills", kind: "analysis", at: 1002, data: { status: "completed", candidates: [{ ...candidate, skill: "other" }, candidate] } });
 await session.prompt("/gskd-insights feedback confirm mixed-skills:1");
 await session.prompt("/gskd-insights review");
 assert(notices.at(-1).includes("2 confirmed, 1 rejected, 0 unconfirmed"), notices.at(-1));
 assert(notices.at(-1).includes("model candidates: 3"), notices.at(-1));
 await session.prompt("/gskd-insights other");
 assert(notices.at(-1).includes("0 confirmed, 0 rejected, 1 unconfirmed"), notices.at(-1));
 assert(notices.at(-1).includes("model candidates: 1"), notices.at(-1));
 for (const [prefix, raw, skill, polarity] of [
  ["feedback", "first line\\n\\t  indented  second line  ", "unknown", "problem"],
  ["feedback --skill review", "  preserve   spacing\\n\\tcode();  ", "review", "problem"],
  ["feedback positive --skill review", "\\n  exact  positive\\ttext  ", "review", "positive"],
 ]) {
  const before = new Set(store.events(root).map(row => row.id));
  await session.prompt("/gskd-insights " + prefix + " " + raw);
  const added = store.events(root).filter(row => row.kind === "feedback" && !before.has(row.id));
  assert.deepEqual(added.map(row => ({ text: row.data.text, skill: row.data.skill, polarity: row.data.polarity })), [{ text: raw, skill, polarity }]);
 }
 assert.deepEqual(errors, []);
 console.log("DECISION_REGRESSION_OK");
} finally { store.close(); await session.dispose(); }
`;
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: resolve(import.meta.dir, ".."),
			env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), REVIEW_PROJECT: root },
			stdout: "pipe", stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect(code, stderr).toBe(0);
		expect(stdout).toContain("DECISION_REGRESSION_OK");
	} finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
