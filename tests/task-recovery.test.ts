import { expect, spyOn, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isKittyProtocolActive, setKittyProtocolActive } from "@oh-my-pi/pi-tui";
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
	detached(event: string, payload: Record<string, unknown>): void;
	persist(messages: TestMessage[]): void;
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
	let history: TestMessage[] = [];
	const ctx = {
		get agent() { return { kind }; }, mode: "tui", hasUI: true,
		sessionManager: { getSessionId: () => sessionId, getLeafId: () => leafId,
			getBranch: () => history.map((message, index) => ({ id: `${index}:${message.role}:${message.timestamp}`, type: "message", message })) },
		ui: { setWidget: (_key: string, content: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined) => {
			status.push(content ? content(undefined, { fg: (_color: string, text: string) => text }).render(80).join("\n") : "");
		},
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
		emit(event: string, payload: Record<string, unknown> = {}) {
			// Normal delivery follows persistence; detached delivery deliberately
			// leaves the authoritative active branch at its newer state.
			if (Array.isArray(payload.messages) && (event === "agent_end" || event === "session_stop")) history = payload.messages as TestMessage[];
			if (event === "message_start" && (payload.message as TestMessage)?.role === "user") history.push(payload.message as TestMessage);
			this.detached(event, payload);
		},
		detached(event: string, payload: Record<string, unknown>) { for (const handler of handlers.get(event) ?? []) handler(payload, ctx); },
		persist(messages: TestMessage[]) { history = messages; },
		stop(message: TestMessage = assistant(), signal?: AbortSignal, messages: unknown[] = [message]) {
			this.emit("session_stop", { messages, last_assistant_message: message, signal, session_id: sessionId });
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
			if (options.sessionId !== undefined && options.sessionId !== sessionId) history = [];
			sessionId = options.sessionId ?? sessionId; leafId = options.leafId ?? leafId; kind = options.kind ?? kind;
		},
	};
}

function recoveryTotals(h: Harness) {
	h.command("status");
	const summary = h.notices.findLast(notice => notice.includes("Completed recoveries:"))!;
	return {
		completed: Number(summary.match(/Completed recoveries: (\d+)/)?.[1]),
		elapsedSeconds: Number(summary.match(/total recovery time: (\d+)s/)?.[1]),
		lastCompletedAt: summary.match(/last completed: (.*)\.$/)?.[1],
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

test("recovery hint exists only during cooldown and clears before normal work resumes", () => withHarness(h => {
	expect(h.status.at(-1)).toBe("");
	h.stop();
	expect(h.status.at(-1)).toContain("Recovery");
	h.fireNext();
	expect(h.status.at(-1)).toBe("");
	h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
	expect(h.status.at(-1)).toBe("");
	h.stop(assistant(2));
	expect(h.status.at(-1)).toContain("Recovery");
	h.command("off");
	expect(h.status.at(-1)).toBe("");
}));

test("multiple retries count as one completed recovery and notify only on the next input", () => withHarness(h => {
	h.stop(); h.fireNext();
	h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
	h.stop(assistant(2)); h.fireNext();
	h.emit("message_start", { message: { role: "custom", ...h.sent[1].message } });
	h.advance(2500);
	const elapsed = Math.ceil(h.now / 1000);
	const completedAt = new Date(h.now).toISOString();
	const success = assistant(3, "stop");
	h.stop(success);
	h.emit("agent_end", { messages: [success], willContinue: false });
	expect(h.notices).toEqual([]);
	h.emit("input", { text: "I'm back", source: "interactive" });
	expect(h.notices).toHaveLength(1);
	expect(h.sent).toHaveLength(2);
	h.emit("input", { text: "next input", source: "interactive" });
	expect(h.notices).toHaveLength(1);
	expect(recoveryTotals(h)).toEqual({ completed: 1, elapsedSeconds: elapsed, lastCompletedAt: completedAt });
	expect(h.sent).toHaveLength(2);
}));

for (const outcome of ["submitted", "aborted", "error", "user replacement", "session switch"] as const) {
	test(`${outcome} does not count as a successful recovery`, () => withHarness(h => {
		h.stop(); h.fireNext();
		if (outcome !== "submitted") h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
		if (outcome === "user replacement") h.emit("input", { text: "replacement" });
		if (outcome === "session switch") { h.emit("session_before_switch"); h.activity({ sessionId: "second" }); h.emit("session_switch"); }
		h.stop(assistant(3, outcome === "aborted" ? "aborted" : outcome === "error" ? "error" : "stop"));
		h.emit("agent_end", { messages: [assistant(3, outcome === "aborted" ? "aborted" : outcome === "error" ? "error" : "stop")], willContinue: false });
		h.emit("input", { text: "back" });
		expect(h.notices).toEqual([]);
		expect(recoveryTotals(h).completed).toBe(0);
		expect(h.sent).toHaveLength(1);
	}));
}

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

for (const data of ["\u001b[27u", "\u001b[27;1u", "\u001b[99;5u", "\u001b[99;5:1u", "\u001b[99;5:2u", "\u001b[27;5;99~"]) {
	test(`host key decoding cancels recovery for ${JSON.stringify(data)}`, () => {
		const kittyWasActive = isKittyProtocolActive();
		setKittyProtocolActive(true);
		try {
			withHarness(h => {
				h.stop();
				expect(h.terminal(data)).toBeUndefined();
				h.advance(600_000);
				expect(h.sent).toHaveLength(0);
				expect(h.timers).toBe(0);
			});
		} finally { setKittyProtocolActive(kittyWasActive); }
	});
}

test("pasted text containing a Ctrl-C byte is not a Ctrl-C keypress", () => withHarness(h => {
	h.stop();
	expect(h.terminal("\u001b[200~pasted\u0003text\u001b[201~")).toBeUndefined();
	h.fireNext();
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

test("retained successful receipts permit continuation without changing history", () => withHarness(h => {
	const tool = { ...assistant(1, "toolUse"), content: [{ type: "toolCall", id: "committed-call", name: "charge", arguments: {} }] };
	const receipt = { role: "toolResult", toolCallId: "committed-call", content: [{ type: "text", text: "committed" }], isError: false };
	const error = assistant(2);
	const history = [tool, receipt, error]; const before = structuredClone(history);
	h.stop(error, undefined, history); h.fireNext();
	expect(history).toEqual(before); expect(h.sent).toHaveLength(1);
}));

test("subagent factories never submit recovery turns", () => withHarness(h => {
	h.activity({ kind: "sub" }); h.emit("session_start"); h.stop(); h.command("on"); h.advance(600_000);
	expect(h.sent).toHaveLength(0);
}));

for (const owner of ["auto_retry_start", "auto_compaction_start", "willContinue", "awaitingAsyncWork"] as const) {
	test(`${owner} preserves the running episode and its original elapsed time`, () => withHarness(h => {
		h.advance(7000);
		const startedAt = h.now;
		h.stop(); h.fireNext();
		h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
		h.advance(1500);
		const intermediate = assistant(2, owner === "awaitingAsyncWork" ? "stop" : "error");
		// Core retry/compaction starts during maintenance, before session_stop;
		// async waits skip session_stop entirely and publish a nonterminal end.
		if (owner === "auto_retry_start" || owner === "auto_compaction_start") h.emit(owner);
		h.emit("agent_end", { messages: [intermediate], willContinue: true, awaitingAsyncWork: owner === "awaitingAsyncWork" });
		expect(h.timers).toBe(0);
		h.advance(4000);
		if (owner === "auto_retry_start") h.emit("auto_retry_end", { success: true, attempt: 1 });
		if (owner === "auto_compaction_start") h.emit("auto_compaction_end", { aborted: false, willRetry: true });
		const success = assistant(3, "stop");
		h.stop(success);
		expect(h.notices).toEqual([]);
		h.emit("agent_end", { messages: [success], willContinue: false });
		h.stop(success);
		h.emit("agent_end", { messages: [success], willContinue: false });
		const elapsedSeconds = Math.ceil((h.now - startedAt) / 1000);
		const lastCompletedAt = new Date(h.now).toISOString();
		h.emit("input", { text: "back" });
		expect(h.notices).toHaveLength(1);
		h.emit("input", { text: "again" });
		expect(h.notices).toHaveLength(1);
		expect(recoveryTotals(h)).toEqual({ completed: 1, elapsedSeconds, lastCompletedAt });
		h.advance(600_000);
		expect(h.sent).toHaveLength(1);
		expect(h.timers).toBe(0);
	}));
}

test("retry exhaustion re-enters extension cooldown without restarting the episode clock", () => withHarness(h => {
	h.advance(9000);
	const startedAt = h.now;
	h.stop(); h.fireNext();
	h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
	h.emit("auto_retry_start");
	h.advance(5000);
	h.emit("agent_end", { messages: [assistant(2)], willContinue: true });
	h.advance(6000);
	h.emit("auto_retry_end", { success: false, finalError: "upstream_http2_stream_error" });
	expect(h.timers).toBe(0);
	const exhausted = assistant(3);
	h.stop(exhausted);
	h.emit("agent_end", { messages: [exhausted], willContinue: false });
	h.stop(exhausted);
	expect(h.timers).toBe(1);
	h.fireNext();
	expect(h.sent).toHaveLength(2);
	h.emit("message_start", { message: { role: "custom", ...h.sent[1].message } });
	const success = assistant(4, "stop");
	h.stop(success);
	h.emit("agent_end", { messages: [success], willContinue: false });
	expect(recoveryTotals(h).completed).toBe(1);
	expect(recoveryTotals(h).elapsedSeconds).toBe(Math.ceil((h.now - startedAt) / 1000));
	expect(h.sent).toHaveLength(2);
}));

test("a session_stop followed by another hook's continuation is not a completed recovery", () => withHarness(h => {
	h.stop(); h.fireNext();
	h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
	const intermediate = assistant(2, "stop");
	h.stop(intermediate);
	h.emit("agent_end", { messages: [intermediate], willContinue: true });
	expect(recoveryTotals(h).completed).toBe(0);
	h.advance(2000);
	const success = assistant(3, "stop");
	h.stop(success);
	h.emit("agent_end", { messages: [success], willContinue: false });
	expect(recoveryTotals(h).completed).toBe(1);
	expect(h.sent).toHaveLength(1);
}));

for (const cancellation of ["off", "Esc", "input", "user message", "new turn", "session switch", "retry cancellation", "compaction cancellation", "settle cancellation"] as const) {
	test(`${cancellation} ends a host-owned running recovery without counting a later user completion`, () => withHarness(h => {
		h.stop(); h.fireNext();
		h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
		h.emit("auto_retry_start");
		h.emit("agent_end", { messages: [assistant(2)], willContinue: true });
		if (cancellation === "off") h.command("off");
		else if (cancellation === "Esc") h.terminal("\u001b");
		else if (cancellation === "input") h.emit("input", { text: "replacement" });
		else if (cancellation === "user message") h.emit("message_start", { message: { role: "user" } });
		else if (cancellation === "new turn") h.emit("before_agent_start", { prompt: "replacement" });
		else if (cancellation === "session switch") { h.emit("session_before_switch"); h.activity({ sessionId: "second" }); h.emit("session_switch"); }
		else if (cancellation === "retry cancellation") h.emit("auto_retry_end", { success: false, finalError: "Retry cancelled" });
		else if (cancellation === "compaction cancellation") h.emit("auto_compaction_end", { aborted: true });
		else { const controller = new AbortController(); controller.abort(); h.stop(assistant(3, "stop"), controller.signal); }
		if (cancellation === "off") expect(h.aborts).toBe(1);
		const success = assistant(4, "stop");
		h.stop(success);
		h.emit("agent_end", { messages: [success], willContinue: false });
		h.emit("input", { text: "back" });
		expect(recoveryTotals(h).completed).toBe(0);
		h.advance(600_000);
		expect(h.sent).toHaveLength(1);
		expect(h.timers).toBe(0);
	}));
}

test("host takeover of an unreceived submission cannot count an unrelated completion", () => withHarness(h => {
	h.stop(); h.fireNext();
	h.emit("auto_retry_start");
	h.emit("agent_end", { messages: [assistant(2)], willContinue: true });
	const success = assistant(3, "stop");
	h.stop(success);
	h.emit("agent_end", { messages: [success], willContinue: false });
	expect(recoveryTotals(h).completed).toBe(0);
	h.advance(600_000);
	expect(h.sent).toHaveLength(1);
}));

test("a dispatched receipt remains identifiable across host takeover but duplicate receipts cannot revive it", () => withHarness(h => {
	h.stop(); h.fireNext();
	const receipt = { role: "custom", ...h.sent[0].message };
	h.emit("auto_retry_start");
	h.emit("message_start", { message: receipt });
	h.emit("message_start", { message: receipt });
	const success = assistant(2, "stop");
	h.stop(success);
	h.emit("agent_end", { messages: [success], willContinue: false });
	h.emit("message_start", { message: receipt });
	h.emit("agent_end", { messages: [assistant(3, "stop")], willContinue: false });
	expect(recoveryTotals(h).completed).toBe(1);
	expect(h.sent).toHaveLength(1);
}));

test("a delayed old submission receipt cannot cancel the next failure's cooldown", () => withHarness(h => {
	h.stop(); h.fireNext();
	const oldReceipt = { role: "custom", ...h.sent[0].message };
	const failure = assistant(2);
	h.stop(failure);
	h.emit("agent_end", { messages: [failure], willContinue: false });
	h.emit("message_start", { message: oldReceipt });
	expect(h.timers).toBe(1);
	expect(recoveryTotals(h).completed).toBe(0);
	h.fireNext();
	expect(h.sent).toHaveLength(2);
	h.emit("message_start", { message: oldReceipt });
	expect(recoveryTotals(h).completed).toBe(0);
	h.emit("message_start", { message: { role: "custom", ...h.sent[1].message } });
	const success = assistant(3, "stop");
	h.stop(success);
	h.emit("agent_end", { messages: [success], willContinue: false });
	expect(recoveryTotals(h).completed).toBe(1);
}));

test("off after a delayed stale receipt does not abort the idle host", () => withHarness(h => {
	h.stop(); h.fireNext();
	h.stop(assistant(2));
	h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
	h.command("off");
	expect(h.aborts).toBe(0);
	expect(h.timers).toBe(0);
	h.advance(600_000);
	expect(h.sent).toHaveLength(1);
}));

test("normal terminal text without every tool receipt is not a successful recovery", () => withHarness(h => {
	h.stop(); h.fireNext();
	h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
	h.emit("auto_compaction_start");
	const tool = { ...assistant(2, "toolUse"), content: [{ type: "toolCall", id: "missing", name: "effect", arguments: {} }] };
	const success = assistant(3, "stop");
	h.stop(success, undefined, [tool, success]);
	h.emit("agent_end", { messages: [tool, success], willContinue: false });
	expect(recoveryTotals(h).completed).toBe(0);
	expect(h.sent).toHaveLength(1);
}));

test("an aborted settle after session_stop cannot turn its pending normal stop into success", () => withHarness(h => {
	h.stop(); h.fireNext();
	h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
	h.emit("auto_retry_start");
	const controller = new AbortController();
	const success = assistant(2, "stop");
	h.stop(success, controller.signal);
	controller.abort();
	h.emit("agent_end", { messages: [success], willContinue: false });
	expect(recoveryTotals(h).completed).toBe(0);
	expect(h.sent).toHaveLength(1);
}));

test("a subsequent unreceived submission stays uncompleted even after an earlier retry ran", () => withHarness(h => {
	h.stop(); h.fireNext();
	h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
	h.stop(assistant(2)); h.fireNext();
	h.emit("auto_retry_start");
	h.emit("agent_end", { messages: [assistant(3, "stop")], willContinue: false });
	expect(recoveryTotals(h).completed).toBe(0);
	expect(h.sent).toHaveLength(2);
}));

test("off clears a subsequent cooldown without aborting an idle host", () => withHarness(h => {
	h.stop(); h.fireNext();
	h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
	h.stop(assistant(2));
	h.command("off");
	expect(h.aborts).toBe(0);
	expect(h.timers).toBe(0);
	h.advance(600_000);
	expect(h.sent).toHaveLength(1);
}));

for (const phase of ["cooldown", "running"] as const) for (const oldOutcome of ["stop", "error", "aborted", "willContinue", "awaitingAsyncWork"] as const) {
	test(`detached old ${oldOutcome} cannot change a newer ${phase} recovery episode`, () => withHarness(h => {
		const oldMessage = assistant(1, oldOutcome === "stop" ? "stop" : oldOutcome === "aborted" ? "aborted" : "error");
		h.stop(oldMessage);
		h.emit("input", { text: "replacement task" });
		const currentFailure = assistant(2);
		h.stop(currentFailure);
		if (phase === "running") {
			h.fireNext();
			h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
		}
		const rendered = [...h.status];
		h.detached("agent_end", { messages: [oldMessage], willContinue: oldOutcome === "willContinue", awaitingAsyncWork: oldOutcome === "awaitingAsyncWork" });
		expect(h.timers).toBe(phase === "cooldown" ? 1 : 0);
		expect(h.status).toEqual(rendered);
		if (phase === "cooldown") {
			h.command("status");
			expect(h.notices.at(-1)).toContain("attempt=1");
			h.fireNext();
			h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
		}
		expect(h.sent).toHaveLength(1);
		expect(recoveryTotals(h).completed).toBe(0);
		const success = assistant(3, "stop");
		h.stop(success);
		h.emit("agent_end", { messages: [success] });
		expect(recoveryTotals(h).completed).toBe(1);
	}));
}

test("detached old agent_end cannot establish recovery in an empty new session", () => withHarness(h => {
	const oldFailure = assistant(1);
	// The older snapshot was detached before this extension observed it;
	// invalidation's last-failure deduplication alone cannot reject it.
	h.stop(assistant(2));
	h.emit("session_before_switch");
	h.activity({ sessionId: "new-session" });
	h.emit("session_switch");
	h.detached("agent_end", { messages: [oldFailure] });
	h.advance(600_000);
	expect(h.sent).toHaveLength(0);
	expect(h.timers).toBe(0);
}));

test("persisted replacement user message rejects an older detached settle", () => withHarness(h => {
	const failure = assistant(1);
	h.stop(failure);
	h.emit("message_start", { message: { role: "user", timestamp: 2, content: [] } });
	h.detached("agent_end", { messages: [failure] });
	h.advance(600_000);
	expect(h.sent).toHaveLength(0);
}));

test("foreign session_stop cannot cancel or replace the current failure", () => withHarness(h => {
	const controller = new AbortController();
	h.stop(assistant(2), controller.signal);
	const aborted = new AbortController();
	aborted.abort();
	h.detached("session_stop", { session_id: "previous-session", messages: [assistant(1)], signal: aborted.signal });
	expect(h.timers).toBe(1);
	h.fireNext();
	expect(h.sent).toHaveLength(1);
}));

test("suspected transport failures receive only two probes while confirmed failures remain unlimited", () => withHarness(h => {
	for (let turn = 1; turn <= 3; turn++) {
		const failure = { ...assistant(turn), errorMessage: "upstream failure" };
		h.stop(failure);
		h.emit("agent_end", { messages: [failure] });
		if (turn <= 2) {
			expect(h.timers).toBe(1);
			h.fireNext();
			h.emit("message_start", { message: { role: "custom", ...h.sent.at(-1)!.message } });
		} else {
			expect(h.timers).toBe(0);
			h.advance(600_000);
		}
	}
	expect(h.sent).toHaveLength(2);
	expect(h.notices.some(notice => notice.includes("two unconfirmed"))).toBe(true);
}));

test("terminal tool-call errors skipped by session_stop still recover with explicit receipts", () => withHarness(h => {
	const failure = { ...assistant(1), content: [{ type: "toolCall", id: "not-run", name: "effect", arguments: {} }] };
	const receipt = { role: "toolResult", toolCallId: "not-run", content: [{ type: "text", text: "interrupted before execution" }],
		isError: true, __synthetic: true, details: { executed: false } };
	h.emit("agent_end", { messages: [failure, receipt] });
	h.fireNext();
	expect(h.sent).toHaveLength(1);
}));

test("a fork inheriting an unobserved old failure cannot acquire its detached recovery", () => withHarness(h => {
	const inheritedFailure = assistant(1);
	h.stop(assistant(2));
	h.emit("session_before_switch");
	h.activity({ sessionId: "fork-session" });
	h.persist([inheritedFailure]);
	h.emit("session_switch");
	h.detached("agent_end", { messages: [inheritedFailure] });
	h.advance(600_000);
	expect(h.sent).toHaveLength(0);
	expect(h.timers).toBe(0);
	// The fork's own later failure remains recoverable.
	const ownFailure = assistant(3);
	h.stop(ownFailure);
	h.emit("agent_end", { messages: [inheritedFailure, ownFailure] });
	h.fireNext();
	expect(h.sent).toHaveLength(1);
}));
