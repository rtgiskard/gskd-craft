import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { classifyFailure, recoveryDelay, type RecoveryFailure } from "./recovery-policy";

const STATUS_KEY = "gskd-recovery";
const RECOVERY_PROMPT = "The previous model turn stopped because of a temporary upstream communication failure. Continue the existing user task from the retained conversation and tool receipts; do not restart the task or repeat successful side effects. A tool result marked __synthetic with executed:false means the host did not execute that call. For any interrupted, missing, or uncertain execution outcome, first inspect the actual state using read-only checks before deciding whether another action is safe. Do not invent tool results or claim an unverified action succeeded. If the task is already complete, report its actual result and stop.";
const MAX_PROBES = 2;
const MAX_TIMER_MS = 2_147_483_647;

type AgentMessage = AgentEndEvent["messages"][number];
type Phase = "cooldown" | "submitted" | "running";
interface Recovery {
	generation: number;
	sessionId: string;
	leafId: string | null;
	failureKey: string;
	failure: RecoveryFailure;
	phase: Phase;
	deadline: number;
	timer?: Timer;
	detachAbort?: () => void;
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

function failureKey(message: AssistantMessage): string {
	return JSON.stringify([message.timestamp, message.api, message.provider, message.model, message.errorMessage, message.errorStatus]);
}

/** Core pairs emitted-but-never-invoked calls with explicit synthetic receipts.
 * A genuinely unpaired call has no public extension API that can establish whether
 * it ran. Refuse that unsafe continuation instead of manufacturing a tool result.
 */
function unpairedCalls(messages: AgentMessage[]): string[] {
	const calls = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
		} else if (message.role === "toolResult") calls.delete(message.toolCallId);
	}
	return [...calls];
}

export default function taskRecovery(pi: ExtensionAPI): void {
	// Extension factories are session-bound, including subagents: no module-global lock.
	let enabled: boolean | undefined;
	let generation = 0;
	let attempts = 0;
	let probes = 0;
	let recovery: Recovery | undefined;
	let diagnostic = "idle";
	let unsubscribeInput: (() => void) | undefined;
	let terminalFailureKey: string | undefined;

	function active(ctx: ExtensionContext): boolean {
		return ctx.agent.kind === "main" && (enabled ?? true);
	}

	function render(ctx: ExtensionContext): void {
		if (ctx.agent.kind !== "main") return;
		const state = !active(ctx) ? "off" : recovery
			? `${recovery.phase} #${attempts}${recovery.phase === "cooldown" ? ` (${Math.max(0, Math.ceil((recovery.deadline - Date.now()) / 1000))}s)` : ""}`
			: diagnostic;
		ctx.ui.setStatus(STATUS_KEY, `recovery: ${state}`);
	}

	function release(ctx: ExtensionContext): void {
		if (!recovery) return;
		if (recovery.timer !== undefined) ctx.clearTimer(recovery.timer);
		recovery.detachAbort?.();
		recovery = undefined;
	}

	function invalidate(ctx: ExtensionContext, reason: string): void {
		generation++;
		// A detached agent_end for this same failure cannot resurrect cancelled work.
		terminalFailureKey = recovery?.failureKey ?? terminalFailureKey;
		release(ctx);
		attempts = 0;
		probes = 0;
		diagnostic = reason;
		render(ctx);
	}

	function pause(ctx: ExtensionContext, reason: string): void {
		release(ctx);
		diagnostic = reason;
		render(ctx);
	}

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
		// Never use sendMessage for status: even hidden custom messages enter model context.
		if (ctx.hasUI) ctx.ui.notify(message, type);
		else pi.logger.info(`[gskd-recovery] ${message}`);
	}

	function current(ctx: ExtensionContext, plan: Recovery): boolean {
		return recovery === plan && plan.generation === generation && active(ctx) &&
			ctx.sessionManager.getSessionId() === plan.sessionId;
	}

	function arm(ctx: ExtensionContext, plan: Recovery, delay: number): void {
		plan.timer = ctx.setTimeout(() => {
			plan.timer = undefined;
			if (!current(ctx, plan)) return;
			if (ctx.sessionManager.getLeafId() !== plan.leafId || ctx.hasPendingMessages()) {
				invalidate(ctx, "superseded by conversation activity");
				return;
			}
			const remaining = plan.deadline - Date.now();
			if (remaining > 0) {
				arm(ctx, plan, remaining);
				return;
			}
			const jobs = ctx.getAsyncJobSnapshot();
			if (!ctx.isIdle() || (jobs && (jobs.running.length > 0 || jobs.delivery.queued > 0 || jobs.delivery.delivering || jobs.delivery.pendingJobIds.length > 0))) {
				// Core owns active retry/compaction/background delivery; never queue behind it.
				arm(ctx, plan, 1_000);
				return;
			}
			plan.phase = "submitted"; // Claim before the void API can synchronously re-enter.
			plan.detachAbort?.();
			plan.detachAbort = undefined;
			render(ctx);
			try {
				pi.sendMessage({
					customType: STATUS_KEY,
					content: RECOVERY_PROMPT,
					display: false,
					attribution: "agent",
					details: { generation: plan.generation, attempt: attempts },
				}, { triggerTurn: true, deliverAs: "nextTurn" });
			} catch (error) {
				pause(ctx, "host rejected recovery submission");
				notify(ctx, `Recovery submission failed: ${String(error)}`, "warning");
			}
		}, Math.min(MAX_TIMER_MS, Math.max(1, delay)));
	}

	function consider(ctx: ExtensionContext, message: AssistantMessage | undefined, messages: AgentMessage[], signal?: AbortSignal): void {
		if (!active(ctx) || !message || signal?.aborted) return;
		const key = failureKey(message);
		if (recovery?.failureKey === key || terminalFailureKey === key) return;
		const failure = classifyFailure(message);
		if (!failure) {
			invalidate(ctx, message.stopReason === "error" ? "not a recoverable communication failure" : message.stopReason === "aborted" ? "cancelled" : "idle");
			terminalFailureKey = key;
			return;
		}
		release(ctx);
		terminalFailureKey = key;
		const missing = unpairedCalls(messages);
		if (missing.length > 0) {
			diagnostic = `paused: ${missing.length} tool outcome(s) unpaired`;
			render(ctx);
			notify(ctx, `Automatic recovery paused: no recorded result for tool call(s) ${missing.join(", ")}. OMP exposes no public repair/verification API for these unknown outcomes; inspect actual state before continuing. No tool results were fabricated.`, "warning");
			return;
		}
		if (failure.kind === "suspected" && probes >= MAX_PROBES) {
			diagnostic = "paused: unconfirmed communication failure probe limit";
			render(ctx);
			notify(ctx, "Automatic recovery paused after two unconfirmed transport-failure probes; inspect the error before continuing.", "warning");
			return;
		}
		if (failure.kind === "suspected") probes++;
		attempts++;
		const plan: Recovery = {
			generation, sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(),
			failureKey: key, failure, phase: "cooldown", deadline: Date.now() + recoveryDelay(attempts, failure.retryAfterMs),
		};
		recovery = plan;
		if (signal) {
			const cancel = () => { if (current(ctx, plan)) invalidate(ctx, "cancelled"); };
			signal.addEventListener("abort", cancel, { once: true });
			plan.detachAbort = () => signal.removeEventListener("abort", cancel);
		}
		render(ctx);
		arm(ctx, plan, plan.deadline - Date.now());
	}

	function bind(ctx: ExtensionContext): void {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		if (ctx.agent.kind === "main" && ctx.mode === "tui") {
			unsubscribeInput = ctx.ui.onTerminalInput(data => {
				if (data === "\u001b" || data.includes("\u0003") || data.includes("\u001b[27;5;99~") || data.includes("\u001b[99;5u")) {
					invalidate(ctx, "cancelled by terminal input");
				}
				// Observe only: never consume or rewrite normal terminal input.
				return undefined;
			});
		}
		render(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		enabled = ctx.agent.kind === "main";
		invalidate(ctx, "idle");
		bind(ctx);
	});
	pi.on("input", (event, ctx) => {
		if (!/^\/gskd-recovery(?:\s|$)/.test(event.text.trim())) invalidate(ctx, "superseded by user input");
	});
	pi.on("before_agent_start", (event, ctx) => {
		// OMP 18.12 custom-only turns bypass this hook. Also protect hosts that emit it.
		if (recovery?.phase === "submitted" && event.prompt === RECOVERY_PROMPT) return;
		invalidate(ctx, "new user turn");
	});
	pi.on("message_start", (event, ctx) => {
		const message = event.message;
		if (message.role === "user") invalidate(ctx, "superseded by user message");
		else if (message.role === "custom" && message.customType === STATUS_KEY && recovery?.phase === "submitted") {
			const details = message.details as { generation?: number; attempt?: number } | undefined;
			if (details?.generation === generation && details.attempt === attempts) {
				recovery.phase = "running";
				render(ctx);
			}
		}
	});
	pi.on("session_stop", (event, ctx) => {
		const message = event.last_assistant_message;
		consider(ctx, message?.role === "assistant" ? message : lastAssistant(event.messages), event.messages, event.signal);
	});
	pi.on("agent_end", (event, ctx) => {
		if (event.willContinue || event.awaitingAsyncWork) {
			pause(ctx, "host recovery/background work owns continuation");
			return;
		}
		// session_stop is deliberately skipped by core for terminal tool-call turns.
		consider(ctx, lastAssistant(event.messages), event.messages);
	});
	pi.on("auto_retry_start", (_event, ctx) => pause(ctx, "host retry in progress"));
	pi.on("auto_compaction_start", (_event, ctx) => pause(ctx, "host compaction in progress"));
	// auto_retry_end.success=false also means cancellation; it must never schedule recovery.
	for (const event of ["session_before_switch", "session_before_branch", "session_before_tree"] as const) {
		pi.on(event, (_event, ctx) => invalidate(ctx, "session context changing"));
	}
	for (const event of ["session_switch", "session_branch", "session_tree"] as const) {
		pi.on(event, (_event, ctx) => { invalidate(ctx, "idle"); bind(ctx); });
	}
	pi.on("session_shutdown", (_event, ctx) => {
		invalidate(ctx, "shutdown");
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("gskd-recovery", {
		description: "Show or control automatic communication-failure recovery: status | on | off",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "off") {
				const ownTurnRunning = recovery?.phase === "running";
				enabled = false;
				invalidate(ctx, "disabled");
				if (ownTurnRunning) ctx.abort();
			} else if (action === "on") {
				enabled = ctx.agent.kind === "main";
				invalidate(ctx, "idle; applies to subsequent failures");
			} else if (action !== "status") {
				notify(ctx, "Usage: /gskd-recovery status|on|off", "warning");
				return;
			}
			render(ctx);
			const state = recovery ? `${recovery.phase}; attempt=${attempts}; probes=${probes}/${MAX_PROBES}; reason=${recovery.failure.reason}; retryAt=${new Date(recovery.deadline).toISOString()}` : diagnostic;
			notify(ctx, `gskd-recovery: ${active(ctx) ? "on" : "off"}; ${state}. Main sessions only. Cooldown: 30/60/120/300s + jitter, respecting available retry hints. Existing receipts retained. Cancellation uses settle AbortSignal and TUI Esc/Ctrl-C; raw non-TUI aborts without a settle signal and already dispatched void submissions cannot be retracted by the public API.`);
		},
	});
}
