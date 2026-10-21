import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { expandPath, resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

const ENTRY_TYPE = "gskd-worktree-location";
const WIDGET_KEY = "gskd-worktree-location";
const GIT_TIMEOUT_MS = 2_000;

export interface GitLocation {
	root: string;
	branch: string | null;
	head: string | null;
}

export interface ExpectedWorktree extends GitLocation {
	directory: string;
	boundAt: number;
}

export interface WorktreeObservation {
	directory: string;
	source: "bash.cwd" | "ctx.cwd";
	toolCallId: string;
	observedAt: number;
	checkedAt: number;
	phase: "start" | "end";
	git: GitLocation | null;
	reason?: string;
}

/** A custom session entry, never a model-visible message. */
export interface WorktreeLocationState {
	version: 1;
	expected: ExpectedWorktree | null;
	latest: WorktreeObservation | null;
}

interface Inspection {
	git: GitLocation | null;
	reason?: string;
}

export interface WorktreeLocationView {
	state: WorktreeLocationState;
	/** Undefined while unchecked; a stored root alone is not evidence of a match. */
	expectedCheck: Inspection | undefined;
	sessionCheck: Inspection | undefined;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function gitLocation(value: unknown): value is GitLocation {
	return object(value) && typeof value.root === "string" && isAbsolute(value.root) &&
		(value.branch === null || typeof value.branch === "string") &&
		(value.head === null || typeof value.head === "string");
}

function timestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function storedState(value: unknown): value is WorktreeLocationState {
	if (!object(value) || value.version !== 1) return false;
	const expected = value.expected;
	if (expected !== null && (!gitLocation(expected) || !object(expected) ||
		typeof expected.directory !== "string" || !isAbsolute(expected.directory) || !timestamp(expected.boundAt))) return false;
	const latest = value.latest;
	return latest === null || (object(latest) && typeof latest.directory === "string" &&
		(latest.source === "bash.cwd" || latest.source === "ctx.cwd") && typeof latest.toolCallId === "string" &&
		timestamp(latest.observedAt) && timestamp(latest.checkedAt) && (latest.phase === "start" || latest.phase === "end") &&
		(latest.git === null || gitLocation(latest.git)) && (latest.reason === undefined || typeof latest.reason === "string"));
}

function localDirectory(value: string, cwd: string): string {
	const expanded = expandPath(value);
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(expanded)) return expanded;
	// Explicit user bindings retain filesystem-root semantics for `/` and do
	// not lexically collapse absolute symlink/.. paths before realpath.
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function declaredDirectory(args: unknown, ctx: ExtensionContext): Pick<WorktreeObservation, "directory" | "source"> {
	const explicit = object(args) && typeof args.cwd === "string" && args.cwd.length > 0;
	if (!explicit) return { directory: ctx.cwd, source: "ctx.cwd" };
	const value = args.cwd as string;
	let directory: string;
	try {
		// Match BashTool: virtual URLs stay virtual; all local spellings use
		// the host resolver, including `/`, @ prefixes and file URLs.
		const router = InternalUrlRouter.instance();
		directory = router.canHandle(value) ? router.normalize(value) : resolveToCwd(value, ctx.cwd);
	} catch {
		// An invalid declaration must not turn this observer into a tool gate.
		directory = value;
	}
	return { directory, source: "bash.cwd" };
}

function invocationResult(isError: boolean, details: unknown): boolean {
	if (object(details) && details.executed === false) return false;
	// The wrapper also emits tool_result for a BashTool throw before launch,
	// with undefined details. Nonzero exits and timeouts instead return these
	// structured execution results. A streamed update is separate evidence.
	return !isError || (object(details) &&
		((typeof details.exitCode === "number" && Number.isFinite(details.exitCode)) || details.timedOut === true));
}

function line(value: string): string {
	return value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "�");
}

function locationLabel(directory: string, sessionCwd: string): string {
	// Relative paths distinguish sibling worktrees even when their basenames match.
	return line(isAbsolute(directory) ? relative(sessionCwd, directory) || basename(directory) || directory : directory);
}

export function worktreeComparison(view: WorktreeLocationView): "unbound" | "unknown" | "match" | "mismatch" {
	const { expected, latest } = view.state;
	if (!expected) return "unbound";
	if (!latest?.git || view.expectedCheck?.git?.root !== expected.root) return "unknown";
	return latest.git.root === expected.root ? "match" : "mismatch";
}

/** Compact presentation only: no filesystem queries or lifecycle side effects. */
export function formatWorktreeStatus(view: WorktreeLocationView, sessionCwd: string): string {
	const { latest } = view.state;
	if (!latest || view.sessionCheck === undefined) return "";
	const comparison = worktreeComparison(view);
	if (latest.git && view.sessionCheck?.git?.root === latest.git.root && comparison !== "mismatch") return "";
	const git = latest.git;
	const branch = git ? git.branch ?? `detached@${git.head?.slice(0, 8) ?? "unknown"}` : "Git未知";
	const agreement = comparison === "mismatch" ? " · 约定偏离" : comparison === "unknown" ? " · 约定未知" : "";
	const session = !view.sessionCheck?.git ? " · session未知" : "";
	return `wt: ${locationLabel(git?.root ?? latest.directory, sessionCwd)} · ${line(branch)}${agreement}${session}`;
}

async function inspectGit(pi: ExtensionAPI, directory: string, signal: AbortSignal): Promise<Inspection> {
	if (signal.aborted) return { git: null, reason: "query cancelled" };
	if (!isAbsolute(directory)) return { git: null, reason: "not a local filesystem directory" };
	try {
		const actualDirectory = await realpath(directory);
		if (signal.aborted) return { git: null, reason: "query cancelled" };
		const rootResult = await pi.exec("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], {
			cwd: actualDirectory, timeout: GIT_TIMEOUT_MS, signal,
		});
		if (rootResult.killed || rootResult.code !== 0) return { git: null, reason: rootResult.killed ? "Git query cancelled or timed out" : "not a readable Git worktree" };
		const root = await realpath(rootResult.stdout.replace(/\r?\n$/, ""));
		if (signal.aborted) return { git: null, reason: "query cancelled" };
		const [branchResult, headResult] = await Promise.all([
			pi.exec("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, timeout: GIT_TIMEOUT_MS, signal }),
			pi.exec("git", ["--no-optional-locks", "rev-parse", "--verify", "HEAD"], { cwd: root, timeout: GIT_TIMEOUT_MS, signal }),
		]);
		if (signal.aborted || branchResult.killed || headResult.killed) return { git: null, reason: "Git query cancelled or timed out" };
		const branch = branchResult.code === 0 ? branchResult.stdout.replace(/\r?\n$/, "") : null;
		const head = headResult.code === 0 ? headResult.stdout.trim() : null;
		if ((branchResult.code !== 0 && branchResult.code !== 1) || (!branch && !head) || (head !== null && !/^[\da-f]{40,64}$/i.test(head))) {
			return { git: null, reason: "Git branch or HEAD is unavailable" };
		}
		return { git: { root, branch, head }, reason: undefined };
	} catch (error) {
		return { git: null, reason: signal.aborted ? "query cancelled" : `directory or Git query unavailable: ${String(error)}` };
	}
}

function expectedInspection(expected: ExpectedWorktree, inspection: Inspection): Inspection {
	return inspection.git && inspection.git.root !== expected.root
		? { git: null, reason: "bound path no longer identifies the bound worktree root" } : inspection;
}

function detailLines(title: string, inspection: Inspection | undefined): string[] {
	if (!inspection?.git) return [`${title}: unknown (${line(inspection?.reason ?? "not checked")})`];
	return [`${title} root: ${JSON.stringify(inspection.git.root)}`, `${title} branch: ${line(inspection.git.branch ?? "(detached)")}`,
		`${title} HEAD: ${inspection.git.head ?? "(unborn)"}`];
}

export function formatWorktreeDetails(view: WorktreeLocationView): string {
	const { expected, latest } = view.state;
	const lines = ["gskd-worktree — task worktree / recent declared execution directory"];
	if (expected) {
		lines.push(`Task binding: explicit /gskd-worktree set, ${new Date(expected.boundAt).toISOString()}`,
			`Bound directory: ${JSON.stringify(expected.directory)}`, `Bound root: ${JSON.stringify(expected.root)}`,
			`Branch / HEAD at binding: ${line(expected.branch ?? "(detached)")} / ${expected.head ?? "(unborn)"}`,
			...detailLines("Task current", view.expectedCheck));
	} else lines.push("Task binding: none (session cwd is not a task agreement)");
	if (latest) {
		lines.push(`Recent declared directory: ${JSON.stringify(latest.directory)}`,
			`Source: ${latest.source === "bash.cwd" ? "structured bash.cwd" : "host ctx.cwd fallback (bash.cwd omitted)"}`,
			`Tool call: ${JSON.stringify(latest.toolCallId)}; phase: ${latest.phase}; observed: ${new Date(latest.observedAt).toISOString()}`,
			`Git checked: ${new Date(latest.checkedAt).toISOString()}`, ...detailLines("Recent", { git: latest.git, reason: latest.reason }));
	} else lines.push("Recent declared execution directory: not observed");
	lines.push(...detailLines("Session workspace", view.sessionCheck));
	lines.push(`Comparison: ${worktreeComparison(view)} (canonical worktree roots only; branch is not enforced)`,
		"Scope: main session bash tools only. This observes the declared directory, not shell-internal cd, git -C, eval, remote execution, or background job completion. No tool is blocked, no branch is switched, and no model request/context message is created.",
		"Usage: /gskd-worktree [status | set <path> | clear]");
	return lines.join("\n");
}

interface Execution {
	epoch: number;
	sessionId: string;
	sequence: number;
	observation: Omit<WorktreeObservation, "git" | "reason" | "checkedAt">;
	confirmed: boolean;
	ended: boolean;
	controller: AbortController;
	probe: Promise<{ inspection: Inspection; expected: ExpectedWorktree | null; expectedCheck: Inspection | undefined; sessionCheck: Inspection; bindingGeneration: number }>;
}

/** The state owner is factory-local, including in cloned/subagent extension instances. */
export default function worktreeLocation(pi: ExtensionAPI): void {
	let state: WorktreeLocationState = { version: 1, expected: null, latest: null };
	let expectedCheck: Inspection | undefined;
	let sessionCheck: Inspection | undefined;
	let rendered: string | undefined;
	let renderGeneration = 0;
	let epoch = 0;
	let bindingGeneration = 0;
	let sequence = 0;
	let selectedSequence = 0;
	let refreshGeneration = 0;
	let sessionId: string | undefined;
	let stopped = false;
	let serialized = "";
	let bindingController: AbortController | undefined;
	const controllers = new Set<AbortController>();
	const executions = new Map<string, Execution>();
	// Nested xd://bash calls have tool_call/result but no bash loop lifecycle.
	// Retain their origin and streamed invocation evidence until the receipt.
	const pendingCalls = new Map<string, { epoch: number; sessionId: string; confirmed: boolean; input: unknown }>();
	const nestedCompletions = new Map<string, Promise<void>>();

	function active(ctx: ExtensionContext): boolean {
		return !stopped && ctx.agent.kind === "main" && sessionId === ctx.sessionManager.getSessionId();
	}

	function render(ctx: ExtensionContext): void {
		if (!active(ctx) || ctx.mode !== "tui" || !ctx.hasUI) return;
		const text = formatWorktreeStatus({ state, expectedCheck, sessionCheck }, ctx.cwd);
		if (text === rendered) return;
		rendered = text;
		const generation = ++renderGeneration;
		if (!text) { ctx.ui.setWidget(WIDGET_KEY, undefined); return; }
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
			render(width) {
				if (width <= 0) return [];
				const clipped = truncateToWidth(text, width);
				return [" ".repeat(Math.max(0, width - visibleWidth(clipped))) + theme.fg("dim", clipped)];
			},
			dispose() {
				// Host replacement may dispose the old component before or after
				// mounting its successor. Only the current owner can drop its cache.
				if (generation === renderGeneration) rendered = undefined;
			},
		}), { placement: "aboveEditor" });
	}

	function notify(ctx: ExtensionContext, message: string, warning = false): void {
		if (ctx.hasUI) ctx.ui.notify(message, warning ? "warning" : "info");
		else pi.logger.info(`[gskd-worktree] ${message}`);
	}

	function persist(): void {
		const next = JSON.stringify(state);
		if (next === serialized) return;
		pi.appendEntry(ENTRY_TYPE, state);
		serialized = next;
	}

	function controller(): AbortController {
		const result = new AbortController();
		controllers.add(result);
		return result;
	}

	function invalidate(): void {
		epoch++;
		bindingGeneration++;
		for (const pending of controllers) pending.abort();
		controllers.clear();
		executions.clear();
		pendingCalls.clear();
		nestedCompletions.clear();
		bindingController = undefined;
	}

	async function probe(directory: string, ctx: ExtensionContext, signal: AbortSignal): Execution["probe"] {
		const expected = state.expected;
		const binding = bindingGeneration;
		const inspectionPromise = inspectGit(pi, directory, signal);
		const checkPromise = expected ? (directory === expected.root ? inspectionPromise : inspectGit(pi, expected.root, signal)) : undefined;
		const sessionPromise = directory === ctx.cwd ? inspectionPromise : inspectGit(pi, ctx.cwd, signal);
		const [inspection, check, session] = await Promise.all([inspectionPromise, checkPromise, sessionPromise]);
		return { inspection, expected, expectedCheck: expected && check ? expectedInspection(expected, check) : undefined, sessionCheck: session, bindingGeneration: binding };
	}

	function current(ctx: ExtensionContext, execution: Execution): boolean {
		return active(ctx) && execution.epoch === epoch && execution.sessionId === sessionId && !execution.controller.signal.aborted;
	}

	async function publish(ctx: ExtensionContext, execution: Execution): Promise<void> {
		if (!current(ctx, execution) || execution.sequence < selectedSequence) return;
		selectedSequence = execution.sequence;
		const result = await execution.probe;
		if (!current(ctx, execution) || execution.sequence !== selectedSequence || (!execution.confirmed && !execution.ended)) return;
		sessionCheck = result.sessionCheck;
		if (state.expected === result.expected && bindingGeneration === result.bindingGeneration) expectedCheck = result.expectedCheck;
		state = { ...state, latest: { ...execution.observation, ...result.inspection, checkedAt: Date.now() } };
		persist();
		render(ctx);
	}

	function begin(ctx: ExtensionContext, toolCallId: string, args: unknown, phase: "start" | "end" = "start"): Execution {
		const previous = executions.get(toolCallId);
		previous?.controller.abort();
		if (previous) controllers.delete(previous.controller);
		const pending = controller();
		const observation = { ...declaredDirectory(args, ctx), toolCallId, observedAt: Date.now(), phase };
		const execution: Execution = {
			epoch, sessionId: ctx.sessionManager.getSessionId(), sequence: ++sequence, observation,
			confirmed: false, ended: phase === "end", controller: pending, probe: probe(observation.directory, ctx, pending.signal),
		};
		executions.set(toolCallId, execution);
		// Start is before the host's approval gate. Capture it, but publish only
		// after a tool-authored update/result proves actual tool invocation.
		return execution;
	}

	async function completeNested(ctx: ExtensionContext, toolCallId: string, input: unknown): Promise<void> {
		const completed = begin(ctx, toolCallId, input, "end");
		executions.delete(toolCallId);
		completed.confirmed = true;
		const completion = publish(ctx, completed);
		nestedCompletions.set(toolCallId, completion);
		try { await completion; } finally {
			if (nestedCompletions.get(toolCallId) === completion) nestedCompletions.delete(toolCallId);
			controllers.delete(completed.controller);
		}
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		const generation = epoch;
		const request = ++refreshGeneration;
		const selected = selectedSequence;
		const latest = state.latest;
		const expected = state.expected;
		const binding = bindingGeneration;
		if (!latest && !expected) return;
		const pending = controller();
		try {
			const [inspection, check, session] = await Promise.all([
				latest ? inspectGit(pi, latest.directory, pending.signal) : undefined,
				expected ? inspectGit(pi, expected.root, pending.signal) : undefined,
				inspectGit(pi, ctx.cwd, pending.signal),
			]);
			if (!active(ctx) || generation !== epoch || pending.signal.aborted || request !== refreshGeneration ||
				state.latest !== latest || selected !== selectedSequence || binding !== bindingGeneration) return;
			sessionCheck = session;
			if (state.expected === expected && binding === bindingGeneration) expectedCheck = expected && check ? expectedInspection(expected, check) : undefined;
			if (latest && inspection) {
				const changed = latest.git?.root !== inspection.git?.root || latest.git?.branch !== inspection.git?.branch ||
					latest.git?.head !== inspection.git?.head || latest.reason !== inspection.reason;
				state = { ...state, latest: { ...latest, ...inspection, checkedAt: Date.now() } };
				// Rechecking unchanged metadata must not move the conversation leaf.
				if (changed) persist();
			}
			render(ctx);
		} finally {
			controllers.delete(pending);
		}
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		invalidate();
		stopped = false;
		sessionId = ctx.sessionManager.getSessionId();
		state = { version: 1, expected: null, latest: null };
		expectedCheck = undefined;
		sessionCheck = undefined;
		rendered = undefined;
		selectedSequence = 0;
		sequence = 0;
		if (!active(ctx)) return;
		// Scan only on lifecycle restoration, never for individual tool logs.
		const entries = ctx.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE && storedState(entry.data)) {
				state = entry.data;
				break;
			}
		}
		serialized = JSON.stringify(state);
		render(ctx);
		await refresh(ctx);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	// Cancellable before_* events are only transition intent. Successful
	// lifecycle restoration invalidates old-session work, not an attempted move.
	for (const event of ["session_switch", "session_branch", "session_tree"] as const) pi.on(event, (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		invalidate();
		stopped = true;
		if (ctx.agent.kind === "main" && ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.on("tool_call", (event, ctx) => {
		if (active(ctx) && event.toolName === "bash" && !executions.has(event.toolCallId)) {
			pendingCalls.set(event.toolCallId, { epoch, sessionId: ctx.sessionManager.getSessionId(), confirmed: false, input: event.input });
		}
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (active(ctx) && event.toolName === "bash") begin(ctx, event.toolCallId, event.args);
	});
	pi.on("tool_execution_update", async (event, ctx) => {
		if (!active(ctx)) return;
		if (event.toolName === "write") {
			const call = pendingCalls.get(event.toolCallId);
			const partial = event.partialResult;
			const details = object(partial) && object(partial.details) ? partial.details : undefined;
			const xdev = details?.xdev;
			if (call && call.epoch === epoch && call.sessionId === sessionId && object(xdev) &&
				xdev.tool === "bash" && xdev.mode === "execute") call.confirmed = true;
			return;
		}
		if (event.toolName !== "bash") return;
		const execution = executions.get(event.toolCallId);
		if (!execution || execution.confirmed) return;
		execution.confirmed = true;
		await publish(ctx, execution);
	});
	pi.on("tool_result", async (event, ctx) => {
		if (!active(ctx) || event.toolName !== "bash") return;
		let execution = executions.get(event.toolCallId);
		if (!execution) {
			const call = pendingCalls.get(event.toolCallId);
			pendingCalls.delete(event.toolCallId);
			if (!call || call.epoch !== epoch || call.sessionId !== sessionId ||
				(!call.confirmed && !invocationResult(event.isError, event.details))) return;
			// The canonical wrapper's receipt is also the completion boundary
			// when the agent loop only emits start/end for the outer write tool.
			await completeNested(ctx, event.toolCallId, event.input);
			return;
		}
		if (!current(ctx, execution)) return;
		if (!execution.confirmed && !invocationResult(event.isError, event.details)) return;
		const declared = declaredDirectory(event.input, ctx);
		if (declared.directory !== execution.observation.directory || declared.source !== execution.observation.source) {
			execution = begin(ctx, event.toolCallId, event.input);
		}
		if (!execution.confirmed) {
			execution.confirmed = true;
			await publish(ctx, execution);
		}
	});
	pi.on("tool_approval_resolved", (event, ctx) => {
		if (!active(ctx) || event.toolName !== "bash" || event.approved) return;
		pendingCalls.delete(event.toolCallId);
		const execution = executions.get(event.toolCallId);
		if (!execution) return;
		execution.controller.abort();
		controllers.delete(execution.controller);
		executions.delete(event.toolCallId);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (!active(ctx)) return;
		const call = pendingCalls.get(event.toolCallId);
		pendingCalls.delete(event.toolCallId);
		if (event.toolName !== "bash") {
			const completion = nestedCompletions.get(event.toolCallId);
			if (completion) { await completion; return; }
			// Cancellation may end the outer write before its inner receipt arrives.
			if (event.toolName === "write" && call?.confirmed && call.epoch === epoch && call.sessionId === sessionId) {
				await completeNested(ctx, event.toolCallId, call.input);
			}
			return;
		}
		const execution = executions.get(event.toolCallId);
		if (!execution) return;
		executions.delete(event.toolCallId);
		execution.ended = true;
		execution.controller.abort();
		controllers.delete(execution.controller);
		const details = object(event.result) && object(event.result.details) ? event.result.details : undefined;
		if (details?.executed === false || (!execution.confirmed && !invocationResult(event.isError, details))) return;
		const pending = controller();
		const completed: Execution = {
			...execution, sequence: ++sequence, confirmed: true, controller: pending,
			observation: { ...execution.observation, phase: "end", observedAt: Date.now() },
			probe: probe(execution.observation.directory, ctx, pending.signal),
		};
		try { await publish(ctx, completed); } finally { controllers.delete(pending); }
	});

	pi.registerCommand("gskd-worktree", {
		description: "Inspect recent declared bash location or explicitly bind task worktree: status | set <path> | clear",
		handler: async (args, ctx) => {
			if (ctx.agent.kind !== "main") { notify(ctx, "gskd-worktree observes main sessions only."); return; }
			if (!active(ctx)) return;
			const action = args.trim() || "status";
			if (action === "status") {
				const generation = epoch;
				await refresh(ctx);
				if (active(ctx) && generation === epoch) notify(ctx, formatWorktreeDetails({ state, expectedCheck, sessionCheck }));
				return;
			}
			if (action === "clear") {
				bindingGeneration++;
				bindingController?.abort();
				bindingController = undefined;
				expectedCheck = undefined;
				state = { ...state, expected: null };
				persist();
				render(ctx);
				notify(ctx, "Task worktree binding cleared; recent declared execution location retained.");
				return;
			}
			const set = /^set\s+([\s\S]+)$/.exec(action);
			if (!set) { notify(ctx, "Usage: /gskd-worktree [status | set <path> | clear]", true); return; }
			let path = set[1].trim();
			if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
			if (!path) { notify(ctx, "set requires a Git worktree path; the existing binding was kept.", true); return; }
			bindingController?.abort();
			const pending = controller();
			bindingController = pending;
			const generation = epoch;
			const binding = ++bindingGeneration;
			try {
				const directory = localDirectory(path, ctx.cwd);
				const inspection = await inspectGit(pi, directory, pending.signal);
				if (!active(ctx) || generation !== epoch || binding !== bindingGeneration || pending.signal.aborted) return;
				if (!inspection.git) {
					notify(ctx, `Cannot bind ${JSON.stringify(directory)}: ${line(inspection.reason ?? "unknown Git worktree")}. Existing binding kept.`, true);
					return;
				}
				state = { ...state, expected: { ...inspection.git, directory, boundAt: Date.now() } };
				expectedCheck = inspection;
				persist();
				render(ctx);
				notify(ctx, formatWorktreeDetails({ state, expectedCheck, sessionCheck }));
			} finally {
				controllers.delete(pending);
				if (bindingController === pending) bindingController = undefined;
			}
		},
	});
}
