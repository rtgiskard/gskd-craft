import { expect, spyOn, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import taskRecovery from "../extensions/task-recovery";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type TestMessage = { role: string; timestamp: number; content: unknown[]; [key: string]: unknown };
type Activity = { idle?: boolean; pending?: boolean; jobs?: boolean; sessionId?: string; leafId?: string; kind?: string };
interface Harness {
	now: number;
	sent: Array<{ message: { customType: string; content: string; details: unknown }; options: unknown }>;
	notices: string[];
	status: string[];
	aborts: number;
	timers: number;
	emit(event: string, payload?: Record<string, unknown>): void;
	stop(message?: TestMessage, signal?: AbortSignal, messages?: unknown[]): void;
	command(args: string): void;
	terminal(data: string): unknown;
	advance(ms: number): void;
	fireNext(): void;
	activity(options: Activity): void;
}
function assistant(timestamp = 1, stopReason: AssistantMessage["stopReason"] = "error") {
	return { role: "assistant", api: "openai-responses", provider: "s2-inc", model: "test", timestamp,
		content: [], stopReason, errorMessage: "upstream_http2_stream_error" };
}

function withHarness(run: (h: Harness) => void) {
	const h = harness();
	const clock = spyOn(Date, "now").mockImplementation(() => h.now);
	try { h.emit("session_start"); run(h); }
	finally { clock.mockRestore(); }
}

function harness(): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const timers = new Map<number, { at: number; callback: () => void }>();
	const sent: Array<{ message: { customType: string; content: string; details: unknown }; options: unknown }> = [];
	const status: string[] = [];
	const notices: string[] = [];
	let input: ((data: string) => unknown) | undefined;
	let nextTimer = 0;
	let now = 0;
	let sessionId = "session-one";
	let leafId = "leaf-one";
	let idle = true;
	let pending = false;
	let jobs = false;
	let kind = "main";
	let aborts = 0;
	const ctx = {
		get agent() { return { kind }; }, mode: "tui", hasUI: true,
		sessionManager: { getSessionId: () => sessionId, getLeafId: () => leafId },
		ui: { setStatus: (_key: string, value: string) => status.push(value),
			notify: (message: string) => notices.push(message),
			onTerminalInput: (handler: (data: string) => unknown) => { input = handler; return () => { input = undefined; }; } },
		isIdle: () => idle, hasPendingMessages: () => pending,
		getAsyncJobSnapshot: () => ({ running: jobs ? ["job"] : [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } }),
		abort: () => { aborts++; },
		setTimeout: (callback: () => void, delay: number) => {
			const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id;
		},
		clearTimer: (id: number) => timers.delete(id),
	} as unknown as ExtensionContext;
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) => commands.set(name, command),
		sendMessage: (message: typeof sent[number]["message"], options: unknown) => sent.push({ message, options }),
		logger: { info: (message: string) => notices.push(message) },
	} as unknown as ExtensionAPI;
	taskRecovery(api);
	return {
		get now() { return now; }, sent, notices, status,
		get aborts() { return aborts; }, get timers() { return timers.size; },
		emit(event: string, payload: Record<string, unknown> = {}) { for (const handler of handlers.get(event) ?? []) handler(payload, ctx); },
		stop(message: TestMessage = assistant(), signal?: AbortSignal, messages: unknown[] = [message]) {
			this.emit("session_stop", { messages, last_assistant_message: message, signal });
		},
		command(args: string) { commands.get("gskd-recovery")!.handler(args, ctx); },
		terminal(data: string) { return input?.(data); },
		fireNext() {
			const deadline = Math.min(...[...timers.values()].map(timer => timer.at));
			if (!Number.isFinite(deadline)) throw new Error("No recovery timer was scheduled");
			this.advance(deadline - now);
		},
		advance(ms: number) {
			const target = now + ms;
			for (;;) {
				const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				timers.delete(next[0]); now = next[1].at; next[1].callback();
			}
			now = target;
		},
		activity(options: Activity) {
			idle = options.idle ?? idle; pending = options.pending ?? pending; jobs = options.jobs ?? jobs;
			sessionId = options.sessionId ?? sessionId; leafId = options.leafId ?? leafId; kind = options.kind ?? kind;
		},
	};
}

test("one submission per failure and unlimited confirmed recovery episodes", () => withHarness(h => {
	for (let turn = 1; turn <= 5; turn++) {
		const message = assistant(turn);
		h.stop(message);
		h.emit("agent_end", { messages: [message], willContinue: false });
		h.stop(message);
		expect(h.timers).toBe(1);
		h.fireNext();
		expect(h.sent).toHaveLength(turn);
		expect(h.sent[turn - 1].options).toEqual({ triggerTurn: true, deliverAs: "nextTurn" });
		h.emit("message_start", { message: { role: "custom", ...h.sent[turn - 1].message } });
	}
}));

test("status and invalid command diagnostics never enter model context or cancel recovery", () => withHarness(h => {
	h.stop(); h.command("status"); h.command("unknown");
	expect(h.sent).toHaveLength(0);
	expect(h.notices.some(notice => notice.includes("gskd-recovery"))).toBe(true);
	h.fireNext();
	expect(h.sent).toHaveLength(1);
}));

for (const cancellation of ["off", "Esc", "Ctrl-C", "new input", "new turn", "session transition", "signal abort", "shutdown"] as const) {
	test(`${cancellation} invalidates a cooling recovery and a late duplicate failure`, () => withHarness(h => {
		const signal = new AbortController();
		const message = assistant(); h.stop(message, signal.signal);
		if (cancellation === "off") h.command("off");
		else if (cancellation === "Esc") expect(h.terminal("\u001b")).toBeUndefined();
		else if (cancellation === "Ctrl-C") expect(h.terminal("\u0003")).toBeUndefined();
		else if (cancellation === "new input") h.emit("input", { text: "new task", source: "interactive" });
		else if (cancellation === "new turn") h.emit("before_agent_start", { prompt: "new task" });
		else if (cancellation === "session transition") h.emit("session_before_switch");
		else if (cancellation === "signal abort") signal.abort();
		else h.emit("session_shutdown");
		h.emit("agent_end", { messages: [message], willContinue: false });
		h.advance(600_000);
		expect(h.sent).toHaveLength(0);
	}));
}

test("ordinary terminal input is observed without consuming or cancelling recovery", () => withHarness(h => {
	h.stop(); expect(h.terminal("hello")).toBeUndefined(); h.fireNext();
	expect(h.sent).toHaveLength(1);
}));

test("off aborts an extension-owned running turn but not an unrelated user turn", () => withHarness(h => {
	h.stop(); h.fireNext();
	h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
	h.command("off"); expect(h.aborts).toBe(1);
	h.command("on"); h.emit("before_agent_start", { prompt: "user task" }); h.command("off");
	expect(h.aborts).toBe(1);
}));

test("waits for host work instead of queueing a duplicate provider turn", () => withHarness(h => {
	h.stop(); h.activity({ idle: false, jobs: true }); h.fireNext();
	expect(h.sent).toHaveLength(0); expect(h.timers).toBe(1);
	h.activity({ idle: true, jobs: false }); h.fireNext();
	expect(h.sent).toHaveLength(1);
}));

test("cooldown and host-work polling do not generate periodic terminal redraws", () => withHarness(h => {
	h.stop();
	h.activity({ idle: false, jobs: true });
	const rendered = [...h.status];
	for (let tick = 0; tick < 50; tick++) h.fireNext();
	expect(h.status).toEqual(rendered);
	expect(h.sent).toHaveLength(0);
}));

for (const activity of [{ pending: true }, { leafId: "new-leaf" }, { sessionId: "new-session" }]) {
	test(`never submits against superseding conversation state ${JSON.stringify(activity)}`, () => withHarness(h => {
		h.stop(); h.activity(activity); h.advance(600_000); expect(h.sent).toHaveLength(0);
	}));
}

test("core-owned continuation takes precedence and retry cancellation does not arm recovery", () => withHarness(h => {
	h.stop(); h.emit("agent_end", { messages: [assistant()], willContinue: true });
	h.emit("auto_retry_end", { success: false }); h.advance(600_000);
	expect(h.sent).toHaveLength(0);
}));

test("does not fabricate receipts or replay calls with genuinely unknown outcomes", () => withHarness(h => {
	const message = { ...assistant(), content: [{ type: "toolCall", id: "unknown-call", name: "charge", arguments: {} }] };
	h.stop(message, undefined, [message]); h.advance(600_000);
	expect(h.sent).toHaveLength(0);
	expect(h.notices.some(notice => notice.includes("unknown-call"))).toBe(true);
}));

test("retained successful receipts permit continuation and direct inspection of uncertain state", () => withHarness(h => {
	const tool = { ...assistant(1, "toolUse"), content: [{ type: "toolCall", id: "committed-call", name: "charge", arguments: {} }] };
	const receipt = { role: "toolResult", toolCallId: "committed-call", content: [{ type: "text", text: "committed" }], isError: false };
	const error = assistant(2);
	const history = [tool, receipt, error]; const before = structuredClone(history);
	h.stop(error, undefined, history); h.fireNext();
	expect(history).toEqual(before); expect(h.sent).toHaveLength(1);
	expect(h.sent[0].message.content).toContain("read-only checks");
}));

test("subagent factories never submit recovery turns", () => withHarness(h => {
	h.activity({ kind: "sub" }); h.emit("session_start"); h.stop(); h.command("on"); h.advance(600_000);
	expect(h.sent).toHaveLength(0);
}));
