import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import { classifyFailure, recoveryDelay, type RecoveryFailure } from "./recovery-policy";

const STATUS_KEY = "gskd-recovery";
const RECOVERY_PROMPT = "The previous model turn stopped because of a temporary upstream communication failure. Continue the existing user task from the retained conversation and tool receipts; do not restart the task or repeat successful side effects. A tool result marked __synthetic with executed:false means the host did not execute that call. For any interrupted, missing, or uncertain execution outcome, first inspect the actual state using read-only checks before deciding whether another action is safe. Do not invent tool results or claim an unverified action succeeded. If the task is already complete, report its actual result and stop.";
const MAX_PROBES = 2;
const MAX_TIMER_MS = 2_147_483_647;

type AgentMessage = AgentEndEvent["messages"][number];
interface Recovery {
	generation: number;
	sessionId: string;
	startedAt: number;
	failureKey: string;
	running: boolean;
	submittedAttempt?: number;
	settleSignal?: AbortSignal;
}
interface Schedule {
	leafId: string | null;
	failure: RecoveryFailure;
	phase: "cooldown" | "submitted";
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
	let schedule: Schedule | undefined;
	let diagnostic = "idle";
	let unsubscribeInput: (() => void) | undefined;
	let terminalFailureKey: string | undefined;
	let inheritedAssistantEntryId: string | undefined;
	let statisticsSessionId: string | undefined;
	let statistics = { completed: 0, elapsedMs: 0, lastCompletedAt: 0, pending: 0, pendingElapsedMs: 0 };

	function reportPending(ctx: ExtensionContext): void {
		if (ctx.agent.kind !== "main" || !statistics.pending) return;
		notify(ctx, `Automatic recovery completed ${statistics.pending} time(s) since your last input; total recovery time ${Math.ceil(statistics.pendingElapsedMs / 1000)}s; last completed ${new Date(statistics.lastCompletedAt).toISOString()}.`);
		statistics.pending = 0;
		statistics.pendingElapsedMs = 0;
	}

	function active(ctx: ExtensionContext): boolean {
		return ctx.agent.kind === "main" && (enabled ?? true);
	}

	function render(ctx: ExtensionContext): void {
		if (ctx.agent.kind !== "main" || ctx.mode !== "tui" || !ctx.hasUI) return;
		if (!active(ctx) || schedule?.phase !== "cooldown") {
			ctx.ui.setWidget(STATUS_KEY, undefined);
			return;
		}
		const seconds = Math.max(0, Math.ceil((schedule.deadline - Date.now()) / 1000));
		const detail = ` · retry #${attempts} after ${seconds}s · Esc to cancel`;
		ctx.ui.setWidget(STATUS_KEY, (_tui, theme) => ({
			render(width) {
				if (width <= 0) return [];
				return [truncateToWidth(theme.fg("warning", "Recovery") + theme.fg("dim", detail), width)];
			},
		}), { placement: "aboveEditor" });
	}

	function releaseSchedule(ctx: ExtensionContext): void {
		if (!schedule) return;
		if (schedule.timer !== undefined) ctx.clearTimer(schedule.timer);
		schedule.detachAbort?.();
		schedule = undefined;
	}

	function invalidate(ctx: ExtensionContext, reason: string): void {
		generation++;
		// A detached agent_end for this same failure cannot resurrect cancelled work.
		terminalFailureKey = recovery?.failureKey ?? terminalFailureKey;
		releaseSchedule(ctx);
		recovery = undefined;
		attempts = 0;
		probes = 0;
		diagnostic = reason;
		render(ctx);
	}

	function pause(ctx: ExtensionContext, reason: string): void {
		// Host work replaces our scheduling, not the recovery episode it continues.
		releaseSchedule(ctx);
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

	function ownsAssistant(ctx: ExtensionContext, message: AssistantMessage | undefined): boolean {
		if (!message) return false;
		// agent_end is detached and has no session/run identity. Its snapshot
		// may arrive after another turn or session; only the persisted active
		// branch can authorize it to change this extension's current episode.
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message") continue;
			const currentMessage = entry.message;
			if (currentMessage.role === "user" || currentMessage.role === "developer") return false;
			if (currentMessage.role === "assistant") {
				return entry.id !== inheritedAssistantEntryId && currentMessage.stopReason === message.stopReason && failureKey(currentMessage) === failureKey(message);
			}
		}
		return false;
	}

	function arm(ctx: ExtensionContext, episode: Recovery, plan: Schedule, delay: number): void {
		plan.timer = ctx.setTimeout(() => {
			plan.timer = undefined;
			if (!current(ctx, episode) || schedule !== plan) return;
			if (ctx.sessionManager.getLeafId() !== plan.leafId || ctx.hasPendingMessages()) {
				invalidate(ctx, "superseded by conversation activity");
				return;
			}
			const remaining = plan.deadline - Date.now();
			if (remaining > 0) {
				arm(ctx, episode, plan, remaining);
				return;
			}
			const jobs = ctx.getAsyncJobSnapshot();
			if (!ctx.isIdle() || (jobs && (jobs.running.length > 0 || jobs.delivery.queued > 0 || jobs.delivery.delivering || jobs.delivery.pendingJobIds.length > 0))) {
				// Core owns active retry/compaction/background delivery; never queue behind it.
				arm(ctx, episode, plan, 1_000);
				return;
			}
			plan.phase = "submitted"; // Claim before the void API can synchronously re-enter.
			episode.submittedAttempt = attempts;
			plan.detachAbort?.();
			plan.detachAbort = undefined;
			render(ctx);
			try {
				pi.sendMessage({
					customType: STATUS_KEY,
					content: RECOVERY_PROMPT,
					display: false,
					attribution: "agent",
					details: { generation: episode.generation, attempt: attempts },
				}, { triggerTurn: true, deliverAs: "nextTurn" });
			} catch (error) {
				invalidate(ctx, "host rejected recovery submission");
				notify(ctx, `Recovery submission failed: ${String(error)}`, "warning");
			}
		}, Math.min(MAX_TIMER_MS, Math.max(1, delay)));
	}

	function consider(ctx: ExtensionContext, message: AssistantMessage | undefined, messages: AgentMessage[], signal?: AbortSignal, settled = false): void {
		if (signal?.aborted || (settled && recovery?.settleSignal?.aborted)) { invalidate(ctx, "cancelled"); return; }
		if (!active(ctx) || !message) return;
		const key = failureKey(message);
		if (recovery?.failureKey === key || terminalFailureKey === key) return;
		const failure = classifyFailure(message);
		if (!failure) {
			// session_stop precedes other hooks' continuation decisions. Only the
			// terminal agent_end can finish an episode, never a submission receipt.
			if (!settled) return;
			if (recovery?.running && !schedule && recovery.submittedAttempt === undefined && current(ctx, recovery) && message.stopReason === "stop" && unpairedCalls(messages).length === 0) {
				const now = Date.now();
				const elapsedMs = Math.max(0, now - recovery.startedAt);
				statistics.completed++;
				statistics.elapsedMs += elapsedMs;
				statistics.lastCompletedAt = now;
				statistics.pending++;
				statistics.pendingElapsedMs += elapsedMs;
			}
			invalidate(ctx, message.stopReason === "error" ? "not a recoverable communication failure" : message.stopReason === "aborted" ? "cancelled" : "idle");
			terminalFailureKey = key;
			return;
		}
		releaseSchedule(ctx);
		terminalFailureKey = key;
		const missing = unpairedCalls(messages);
		if (missing.length > 0) {
			invalidate(ctx, `paused: ${missing.length} tool outcome(s) unpaired`);
			terminalFailureKey = key;
			notify(ctx, `Automatic recovery paused: no recorded result for tool call(s) ${missing.join(", ")}. OMP exposes no public repair/verification API for these unknown outcomes; inspect actual state before continuing. No tool results were fabricated.`, "warning");
			return;
		}
		if (failure.kind === "suspected" && probes >= MAX_PROBES) {
			invalidate(ctx, "paused: unconfirmed communication failure probe limit");
			terminalFailureKey = key;
			notify(ctx, "Automatic recovery paused after two unconfirmed transport-failure probes; inspect the error before continuing.", "warning");
			return;
		}
		if (failure.kind === "suspected") probes++;
		attempts++;
		const episode = recovery ?? {
			generation, sessionId: ctx.sessionManager.getSessionId(), startedAt: Date.now(), failureKey: key, running: false,
			settleSignal: signal,
		};
		episode.failureKey = key;
		// A new failure supersedes the prior submission, including a receipt
		// whose message_start handler has not reached this extension yet.
		episode.submittedAttempt = undefined;
		const plan: Schedule = {
			leafId: ctx.sessionManager.getLeafId(), failure, phase: "cooldown",
			deadline: Date.now() + recoveryDelay(attempts, failure.retryAfterMs),
		};
		recovery = episode;
		schedule = plan;
		if (signal) {
			const cancel = () => { if (current(ctx, episode) && schedule === plan) invalidate(ctx, "cancelled"); };
			signal.addEventListener("abort", cancel, { once: true });
			plan.detachAbort = () => signal.removeEventListener("abort", cancel);
		}
		render(ctx);
		arm(ctx, episode, plan, plan.deadline - Date.now());
	}

	function bind(ctx: ExtensionContext): void {
		const sessionId = ctx.sessionManager.getSessionId();
		// A fork/resume can inherit the exact assistant from an old detached
		// notification. Only assistants persisted after this binding own work here.
		inheritedAssistantEntryId = ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant")?.id;
		if (statisticsSessionId !== sessionId) {
			statisticsSessionId = sessionId;
			statistics = { completed: 0, elapsedMs: 0, lastCompletedAt: 0, pending: 0, pendingElapsedMs: 0 };
		}
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		if (ctx.agent.kind === "main" && ctx.mode === "tui") {
			unsubscribeInput = ctx.ui.onTerminalInput(data => {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
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
		reportPending(ctx);
		if (!/^\/gskd-recovery(?:\s|$)/.test(event.text.trim())) invalidate(ctx, "superseded by user input");
	});
	pi.on("before_agent_start", (event, ctx) => {
		// OMP 18.12 custom-only turns bypass this hook. Also protect hosts that emit it.
		if (recovery?.submittedAttempt !== undefined && event.prompt === RECOVERY_PROMPT) return;
		invalidate(ctx, "new user turn");
	});
	pi.on("message_start", (event, ctx) => {
		const message = event.message;
		if (message.role === "user") invalidate(ctx, "superseded by user message");
		else if (message.role === "custom" && message.customType === STATUS_KEY && recovery?.submittedAttempt !== undefined) {
			const details = message.details as { generation?: number; attempt?: number } | undefined;
			if (details?.generation === recovery.generation && details.attempt === recovery.submittedAttempt && current(ctx, recovery)) {
				recovery.running = true;
				recovery.submittedAttempt = undefined;
				releaseSchedule(ctx);
				diagnostic = "running";
				render(ctx);
			}
		}
	});
	pi.on("session_stop", (event, ctx) => {
		if (event.session_id !== ctx.sessionManager.getSessionId()) return;
		const message = event.last_assistant_message;
		if (recovery) recovery.settleSignal = event.signal;
		consider(ctx, message?.role === "assistant" ? message : lastAssistant(event.messages), event.messages, event.signal);
	});
	pi.on("agent_end", (event, ctx) => {
		const message = lastAssistant(event.messages);
		if (!ownsAssistant(ctx, message)) return;
		if (event.willContinue || event.awaitingAsyncWork) {
			pause(ctx, "host recovery/background work owns continuation");
			return;
		}
		// session_stop is deliberately skipped by core for terminal tool-call turns.
		consider(ctx, message, event.messages, undefined, true);
	});
	pi.on("auto_retry_start", (_event, ctx) => pause(ctx, "host retry in progress"));
	pi.on("auto_compaction_start", (_event, ctx) => pause(ctx, "host compaction in progress"));
	// Exhaustion is followed by session_stop/terminal agent_end; do not schedule
	// from retry-end itself. Cancellation can leave an older normal assistant tail.
	pi.on("auto_retry_end", (event, ctx) => {
		if (!event.success && event.finalError === "Retry cancelled") invalidate(ctx, "cancelled");
	});
	pi.on("auto_compaction_end", (event, ctx) => {
		if (event.aborted) invalidate(ctx, "cancelled");
	});
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
		ctx.ui.setWidget(STATUS_KEY, undefined);
	});

	pi.registerCommand("gskd-recovery", {
		description: "Show or control automatic communication-failure recovery: status | on | off",
		handler: async (args, ctx) => {
			reportPending(ctx);
			const action = args.trim() || "status";
			if (action === "off") {
				const ownTurnRunning = recovery?.running && !schedule;
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
			const state = schedule ? `${schedule.phase}; attempt=${attempts}; probes=${probes}/${MAX_PROBES}; reason=${schedule.failure.reason}; retryAt=${new Date(schedule.deadline).toISOString()}` : diagnostic;
			const summary = `Completed recoveries: ${statistics.completed}; total recovery time: ${Math.ceil(statistics.elapsedMs / 1000)}s; last completed: ${statistics.completed ? new Date(statistics.lastCompletedAt).toISOString() : "never"}.`;
			notify(ctx, summary);
			notify(ctx, `gskd-recovery: ${active(ctx) ? "on" : "off"}; ${state}. Main sessions only. Cooldown: 30/60/120/300s + jitter, respecting available retry hints. Existing receipts retained. Cancellation uses settle AbortSignal and TUI Esc/Ctrl-C; raw non-TUI aborts without a settle signal and already dispatched void submissions cannot be retracted by the public API.`);
		},
	});
}
