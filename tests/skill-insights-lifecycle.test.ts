import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("SDK insight requests keep current lifecycle ownership, live models and bounded shutdown resources", async () => {
	const root = await mkdtemp(join(tmpdir(), "gskd-insights-lifecycle-"));
	try {
		// Isolate the controlled model boundary and SDK profile from all other test files.
		const script = `
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { mkdir } from "node:fs/promises";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createAgentSession, SessionManager, Settings, AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { StatsStore, statisticsSnapshot, summarize } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../extensions/skill-stats-core.ts")).href)};
const requests = [], arrivals = [];
mock.module("@oh-my-pi/pi-ai", () => ({ completeSimple: (model, context, options) => {
 const deferred = Promise.withResolvers();
 const index = requests.push({ model, context, options, resolve: deferred.resolve }) - 1;
 arrivals[index]?.resolve();
 return deferred.promise;
} }));
// Load after installing the controlled provider boundary; static import would run before the mock.
const { default: insights } = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../extensions/skill-insights.ts")).href)});
const root = process.env.REVIEW_PROJECT;
const a = root + "/a", b = root + "/b";
await mkdir(a); await mkdir(b);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const dbPath = agentDir + "/gskd-skill-insights.sqlite";
const ledger = new StatsStore(dbPath);
const closed = new Set();
const close = StatsStore.prototype.close;
StatsStore.prototype.close = function() { if (this !== ledger) closed.add(this); return close.call(this); };
const completed = new Map();
const record = StatsStore.prototype.record;
StatsStore.prototype.record = function(row) {
 record.call(this, row);
 if (row.kind === "analysis" && row.data.status === "completed") completed.get(row.data.model)?.resolve();
};
function completion(model) { const deferred = Promise.withResolvers(); completed.set("gskd-insights-test/" + model, deferred); return deferred.promise; }
const notices = [], errors = [], timers = new Map();
let nextTimer = 0;
const models = ["a", "b", "c"].map(id => buildModel({ id, name: id, provider: "gskd-insights-test", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
const timed = ctx => new Proxy(ctx, { get(target, key, receiver) {
 if (key === "setTimeout") return callback => { const id = ++nextTimer; timers.set(id, callback); return id; };
 if (key === "clearTimer") return id => { if (!timers.delete(id)) target.clearTimer(id); };
 return Reflect.get(target, key, receiver);
} });
let commandProvenance;
const extension = api => {
 api.registerProvider("gskd-insights-test", { baseUrl: models[0].baseUrl, api: models[0].api, apiKey: "test-only", models });
 insights(new Proxy(api, { get(target, key, receiver) {
 if (key === "getCommands") return () => commandProvenance ?? target.getCommands();
 if (key === "on") return (name, handler) => target.on(name, (event, ctx) => handler(event, timed(ctx)));
 if (key === "registerCommand") return (name, command) => target.registerCommand(name, { ...command, handler: (args, ctx) => command.handler(args, timed(ctx)) });
 return Reflect.get(target, key, receiver);
} }));
};
async function create(cwd, sub = false) {
 const { session } = await createAgentSession({ cwd, agentDir, model: models[0], getApiKey: async () => "test-only", sessionManager: SessionManager.inMemory(cwd), taskDepth: sub ? 1 : 0, agentId: sub ? "insights-child" : "insights-main", settings: Settings.isolated({ "memory.backend": "off", "memories.enabled": false, "telemetry.otlpExportEnabled": false, "compaction.enabled": false, "retry.enabled": false }), agentRegistry: new AgentRegistry(), bindProcessState: false, hasUI: false, cacheWarming: false, autoTitle: false, enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true, toolNames: [], skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [], preloadedCustomToolPaths: [], disableExtensionDiscovery: true, extensions: [extension] });
 await initializeExtensions(session, { mode: "rpc", uiContext: { ...session.extensionRunner.getUIContext(), notify: text => notices.push(text) }, reportRuntimeError: error => errors.push(error), reportSendError: (_action, error) => errors.push(error) });
 return session;
}
const response = text => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(text) }], usage: {} });
async function arrival(index) {
 if (requests[index]) return;
 const deferred = arrivals[index] ??= Promise.withResolvers();
 await deferred.promise;
}
function fireTimer() {
 assert.equal(timers.size, 1, "Exactly one current lifecycle timer must own idle analysis");
 const [id, callback] = timers.entries().next().value; timers.delete(id); callback();
}
let main, sub;
try {
 main = await create(a);
 await main.prompt("/gskd-insights feedback --skill review evidence from A");
 const advice = main.prompt("/gskd-insights advice");
 await arrival(0);
 assert.equal(requests[0].model.id, "a");
 const adviceNotice = notices.length;
 await main.moveSession(b);
 await main.setModel(models[1]);
 assert.equal(await main.newSession(), true);
 const sessionB = main.sessionManager.getSessionId();
 const entryB = main.sessionManager.appendMessage({ role: "user", content: "B-only transcript", timestamp: Date.now() });
 requests[0].resolve(response({ recommendations: [], limitations: [] }));
 await advice;
 assert(!notices.slice(adviceNotice).some(text => text.startsWith("Skill 使用建议")), "A's cancelled advice must not display in B");
 fireTimer();
 await arrival(1);
 assert.equal(requests[1].model.id, "b");
 const inputB = JSON.parse(requests[1].context.messages[0].content);
 assert(inputB.messages.some(fragment => fragment.messageId === entryB));
 assert(inputB.messages.every(fragment => fragment.text.includes("B-only transcript")));
 const completedBSignal = completion("b");
 requests[1].resolve(response({ candidates: [] }));
 await completedBSignal;
 const completedB = ledger.events(b).find(row => row.kind === "analysis" && row.data.status === "completed");
 assert.equal(completedB.session, sessionB); assert.equal(completedB.cwd, b); assert.equal(completedB.data.model, "gskd-insights-test/b");
 assert(!ledger.events(a).some(row => row.kind === "analysis"));
 // The SDK command context really snapshots .model, while its model query stays live.
 const frozen = main.extensionRunner.createCommandContext();
 assert.equal(frozen.model.id, "b");
 await main.prompt("/gskd-insights analysis off");
 await main.prompt("/gskd-insights analysis on");
 await main.setModel(models[2]);
 assert.equal(frozen.model.id, "b"); assert.equal(frozen.models.current().id, "c");
 main.sessionManager.appendMessage({ role: "user", content: "C-selected evidence", timestamp: Date.now() });
 fireTimer();
 await arrival(2);
 assert.equal(requests[2].model.id, "c");
 const completedCSignal = completion("c");
 requests[2].resolve(response({ candidates: [] }));
 await completedCSignal;
 await main.dispose(); main = undefined;
 assert.equal(timers.size, 0);
 // A rebound subagent extension opens a ledger only after a completed read.
 sub = await create(b, true);
 const runner = sub.extensionRunner;
 const source = b + "/SKILL.md";
 const call = { type: "tool_call", toolName: "read", toolCallId: "read-1", input: { path: "skill://review" } };
 const receipt = { type: "tool_result", toolName: "read", toolCallId: "read-1", input: { path: "skill://review" }, isError: false, content: [{ type: "text", text: "first returned evidence" }], details: { resolvedPath: source, meta: { source: { type: "internal", value: "skill://review" } } } };
 // Registered command provenance is captured at invocation, not re-read on receipt.
 commandProvenance = [{ name: "skill:review", source: "skill", path: source }];
 await runner.emitToolCall(call);
 commandProvenance = [{ name: "skill:wrong-owner", source: "skill", path: source }];
 await runner.emitToolCall(call);
 await runner.emitToolResult(receipt);
 const first = ledger.events(b).find(row => row.kind === "read");
 assert(first); assert.equal(first.data.skill, "review"); assert.equal(first.data.source, source); assert.equal(first.data.section, "entry");
 assert(first.agent.startsWith("sub:"));
 commandProvenance = [{ name: "skill:review", source: "skill", path: source }];
 await runner.emitToolCall(call);
 await runner.emitToolResult({ ...receipt, content: [{ type: "text", text: "duplicate replacement" }] });
 assert.deepEqual(ledger.events(b).filter(row => row.kind === "read"), [first]);
 await runner.emitToolCall({ ...call, toolCallId: "read-pending" });
 const closedBefore = closed.size;
 await sub.dispose(); sub = undefined;
 assert.equal(closed.size, closedBefore + 1, "Subagent shutdown closes its owned SQLite connection");
 await runner.emitToolResult({ ...receipt, toolCallId: "read-pending" });
 assert.deepEqual(ledger.events(b).filter(row => row.kind === "read"), [first]);
 const exported = statisticsSnapshot(dbPath, b);
 assert.deepEqual(exported.events, ledger.events(b));
 assert.equal(summarize(exported.events), summarize(ledger.events(b)));
 assert(summarize(exported.events).includes("Reads: 1 entry, 0 reference"));
 assert.deepEqual(errors, []);
 console.log("LIFECYCLE_REGRESSION_OK");
} finally {
 for (const request of requests) request.resolve(response({ candidates: [], recommendations: [], limitations: [] }));
 await main?.dispose(); await sub?.dispose(); ledger.close();
}
`;
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: resolve(import.meta.dir, ".."),
			env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), REVIEW_PROJECT: root },
			stdout: "pipe", stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect(code, stderr).toBe(0);
		expect(stdout).toContain("LIFECYCLE_REGRESSION_OK");
	} finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
