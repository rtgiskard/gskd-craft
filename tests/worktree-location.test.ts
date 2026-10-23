import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	AgentRegistry, createAgentSession, SessionManager, Settings,
	type AgentSession, type ExecOptions, type ExecResult, type ExtensionAPI,
	type ExtensionUIContext, type ExtensionUiComponent, type ExtensionWidgetContent, type ExtensionWidgetOptions, type ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createNoOpUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/utils";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { Container, visibleWidth, type TUI } from "@oh-my-pi/pi-tui";
import worktreeLocation, { type WorktreeLocationState as Snapshot } from "../extensions/worktree-location";

type QueryPhase = "command" | "start" | "end";

interface QueryHold {
	entered: Promise<void>;
	release(): void;
}

interface ReceiptHold {
	entered: Promise<ToolResultEvent>;
	delivered: Promise<void>;
	release(): void;
}

interface ReceiptControl {
	event?: ToolResultEvent;
	entered(event: ToolResultEvent): void;
	released: Promise<void>;
	delivered(): void;
	release(): void;
}

interface GitQueryGate {
	arm(directory: string, phase?: QueryPhase, argument?: string): QueryHold;
	exec(api: ExtensionAPI, command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	releaseAll(): void;
}
interface LocationFixture {
	a: string;
	b: string;
	other: string;
	plain: string;
	subdirectory: string;
	root: string;
	gate: GitQueryGate;
	session: AgentSession;
	notices: string[];
	errors: unknown[];
	forbiddenUi: string[];
	readonly uiChanges: number;
	readonly dispatches: number;
	readonly wireRequests: number;
	readonly extensionSends: number;
	currentWidget(): ExtensionUiComponent | undefined;
	clearWidgets(): void;
	render(width?: number): string[];
	renderLayout(width?: number): string[];
	command(args?: string): Promise<void>;
	bash(directory?: string, command?: string, options?: { async?: boolean; name?: string; timeout?: number }): Promise<{ id: string; result: unknown; isError: boolean }>;
	writeBash(directory: string, command?: string, options?: { async?: boolean; name?: string; timeout?: number }, controls?: { id?: string; signal?: AbortSignal; onUpdate?(update: unknown): void }): Promise<{ id: string; result: unknown; isError: boolean }>;
	holdBashReceipt(): ReceiptHold;
	rewriteNextBash(from: string, to: string): void;
	cancelSessionSwitch(): void;
	close(): Promise<void>;
}

// The only controlled seam is delivery timing: every Git query still executes
// against the actual temporary repository before its result can be delayed.
function queryGate(scope: AsyncLocalStorage<QueryPhase>): GitQueryGate {
	let armed: { directory: string; phase?: QueryPhase; argument?: string; entered: () => void; released: Promise<void> } | undefined;
	const releases = new Set<() => void>();
	return {
		arm(directory: string, phase?: QueryPhase, argument?: string) {
			if (armed) throw new Error("A Git query is already armed");
			const entered = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			const release = () => { releases.delete(release); released.resolve(); };
			releases.add(release);
			armed = { directory, phase, argument, entered: entered.resolve, released: released.promise };
			return { entered: entered.promise, release };
		},
		async exec(api: ExtensionAPI, command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
			const pending = command === "git" && armed && (!armed.phase || armed.phase === scope.getStore()) &&
				(!armed.argument || args.includes(armed.argument)) &&
				(options?.cwd === armed.directory || args.includes(armed.directory)) ? armed : undefined;
			if (pending) armed = undefined;
			const result = await api.exec(command, args, options);
			if (pending) { pending.entered(); await pending.released; }
			return result;
		},
		releaseAll() { armed = undefined; for (const release of releases) release(); },
	};
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], {
		cwd, stdout: "pipe", stderr: "pipe",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Location test", GIT_AUTHOR_EMAIL: "location@example.invalid",
			GIT_COMMITTER_NAME: "Location test", GIT_COMMITTER_EMAIL: "location@example.invalid" },
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout.trim();
}

async function repository(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	await git(directory, "init", "-q", "--initial-branch=shared-name");
	await writeFile(join(directory, "tracked.txt"), "location fixture\n");
	await git(directory, "add", "tracked.txt");
	await git(directory, "commit", "-qm", "Initial fixture");
}

function snapshot(session: AgentSession): Snapshot | undefined {
	for (const entry of session.sessionManager.getBranch().toReversed()) {
		if (entry.type === "custom" && entry.customType === "gskd-worktree-location") return entry.data as Snapshot;
	}
	return undefined;
}

function toolText(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
		throw new Error("Tool did not return SDK content");
	}
	return result.content.flatMap(item => item && typeof item === "object" &&
		item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
}

function visible(text: string): string { return Bun.stripANSI(text); }
const mismatch = /偏离|不一致|mismatch|≠/i;
const unknown = /未知|unknown|不可用|unavailable|失效|无法/i;

async function fixture(options: { deviceBash?: boolean } = {}): Promise<LocationFixture> {
	const temporary = await mkdtemp(join(tmpdir(), "gskd-location-"));
	const root = await realpath(temporary);
	const a = join(root, "checkout-a");
	const b = join(root, "checkout-b");
	const other = join(root, "another-repository");
	const plain = join(root, "not-a-repository");
	const subdirectory = join(a, "nested", "source");
	const agentDir = join(root, "agent");
	await repository(a);
	await git(a, "worktree", "add", "-qb", "worktree-b", b);
	await repository(other); // Same branch name, but definitely not the same root.
	await Promise.all([mkdir(plain), mkdir(subdirectory, { recursive: true }), mkdir(agentDir)]);
	const scope = new AsyncLocalStorage<QueryPhase>();
	const gate = queryGate(scope);
	const notices: string[] = [];
	const errors: unknown[] = [];
	const widgets = new Map<string, string[] | ExtensionUiComponent>();
	const theme = (await getThemeByName("dark"))!;
	const tui = { requestRender() {} } as TUI;
	const above = new Container();
	const below = new Container();
	const controller = new ExtensionUiController({
		hookWidgetContainerAbove: above, hookWidgetContainerBelow: below,
		// An unoccupied status row keeps the existing editor gap stable across composer shapes.
		statusRowOccupied: false, ui: tui,
	} as InteractiveModeContext);
	const layout = new Container();
	layout.addChild({ render: () => ["RUNNING · TOPIC"] });
	layout.addChild(above);
	layout.addChild({ render: () => ["> INPUT"] });
	layout.addChild(below);
	const forbiddenUi: string[] = [];
	let uiChanges = 0;
	let dispatches = 0;
	let wireRequests = 0;
	let extensionSends = 0;
	let cancelSwitch = false;
	let rewrite: { from: string; to: string } | undefined;
	const receiptHolds = new Set<ReceiptControl>();
	let armedReceipt: ReceiptControl | undefined;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
		wireRequests++;
		return Response.json({ error: { message: "No model call is permitted by this fixture" } }, { status: 400 });
	} });
	const provider = "gskd-worktree-test";
	const model = buildModel({
		id: "location", name: "Location test", provider, api: "openai-responses" as const,
		baseUrl: `http://127.0.0.1:${server.port}/v1`, reasoning: false, input: ["text" as const],
		contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const ui = {
		...createNoOpUIContext(),
		notify: (message: string) => notices.push(message),
		onTerminalInput: () => () => {},
		setWidget: (key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions) => {
			widgets.delete(key);
			controller.setHookWidget(key, typeof content === "function" ? hostTui => {
				const widget = content(hostTui, theme);
				widgets.set(key, widget);
				return widget;
			} : content, options);
			if (Array.isArray(content)) widgets.set(key, content);
			uiChanges++;
		},
		setStatus: () => { forbiddenUi.push("setStatus"); },
		setFooter: () => { forbiddenUi.push("setFooter"); },
		setHeader: () => {}, setWorkingMessage: () => {}, setTitle: () => {},
	} as unknown as ExtensionUIContext;
	let session: AgentSession;
	try {
		({ session } = await createAgentSession({
			cwd: a, agentDir, model, getApiKey: async () => "local-only-not-a-secret",
			sessionManager: SessionManager.create(a, join(root, "sessions")),
			settings: Settings.isolated({
				"retry.enabled": false, "compaction.enabled": false, "memory.backend": "off",
				"memories.enabled": false, "telemetry.otlpExportEnabled": false,
				"providers.openaiWebsockets": "off",
				"bash.autoBackground.enabled": false,
				"async.enabled": false, "launch.enabled": true,
				"tools.xdev": options.deviceBash === true,
			}),
			agentRegistry: new AgentRegistry(), bindProcessState: false,
			hasUI: true, cacheWarming: false, autoTitle: false,
			enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
			toolNames: options.deviceBash ? ["read", "write", "bash"] : ["bash"],
			autoApprove: true,
			skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
			preloadedCustomToolPaths: [], disableExtensionDiscovery: true,
			onFirstChatDispatch: () => { dispatches++; },
			extensions: [api => {
				api.registerProvider(provider, { baseUrl: model.baseUrl, api: model.api,
					apiKey: "local-only-not-a-secret", models: [model] });
				// Delay only delivery to the observer, never execution or the SDK's
				// authoritative input. This hook runs before the location extension.
				api.on("tool_result", async event => {
					if (event.toolName !== "bash" || !armedReceipt) return;
					const hold = armedReceipt;
					armedReceipt = undefined;
					hold.event = event;
					hold.entered(event);
					await hold.released;
				});
				worktreeLocation(new Proxy(api, { get(target, property, receiver) {
					if (property === "exec") return (command: string, args: string[], options?: ExecOptions) => gate.exec(target, command, args, options);
					if (property === "sendMessage" || property === "sendUserMessage") {
						const send = Reflect.get(target, property, receiver) as (...args: unknown[]) => unknown;
						return (...args: unknown[]) => { extensionSends++; return send(...args); };
					}
					return Reflect.get(target, property, receiver);
				} }));
				api.on("tool_result", event => {
					if (event.toolName !== "bash") return;
					for (const hold of receiptHolds) if (hold.event === event) {
						receiptHolds.delete(hold);
						hold.delivered();
					}
				});
				// A later extension revises input after the location observer saw
				// tool_call. The canonical wrapper alone knows what actually ran.
				api.on("tool_call", event => {
					if (event.toolName !== "bash" || !rewrite || event.input.cwd !== rewrite.from) return;
					const cwd = rewrite.to;
					rewrite = undefined;
					return { input: { ...event.input, cwd } };
				});
				// Registered after the location observer: a before-switch event is
				// only an attempted transition until this later hook accepts it.
				api.on("session_before_switch", () => cancelSwitch ? { cancel: true } : undefined);
			}],
		}));
		await initializeExtensions(session, { mode: "tui", uiContext: ui,
			reportRuntimeError: error => errors.push(error), reportSendError: (_action, error) => errors.push(error) });
	} catch (error) {
		gate.releaseAll(); server.stop(true); await rm(root, { recursive: true, force: true }); throw error;
	}
	let nextCall = 0;
	return {
		a, b, other, plain, subdirectory, root, gate, session, notices, errors, forbiddenUi,
		get uiChanges() { return uiChanges; },
		get dispatches() { return dispatches; }, get wireRequests() { return wireRequests; },
		get extensionSends() { return extensionSends; },
		cancelSessionSwitch() { cancelSwitch = true; },
		rewriteNextBash(from, to) { rewrite = { from, to }; },
		holdBashReceipt() {
			if (armedReceipt) throw new Error("A canonical bash receipt is already armed");
			const entered = Promise.withResolvers<ToolResultEvent>();
			const released = Promise.withResolvers<void>();
			const delivered = Promise.withResolvers<void>();
			const hold = { entered: entered.resolve, released: released.promise, delivered: delivered.resolve,
				release() { released.resolve(); } };
			receiptHolds.add(hold);
			armedReceipt = hold;
			return { entered: entered.promise, delivered: delivered.promise, release: hold.release };
		},
		currentWidget() { return [...widgets.values()].find((widget): widget is ExtensionUiComponent => !Array.isArray(widget)); },
		clearWidgets() {
			for (const key of widgets.keys()) controller.setHookWidget(key, undefined);
			widgets.clear();
		},
		render(width = 240): string[] {
			return [...widgets.values()].flatMap(widget => Array.isArray(widget) ? widget : widget.render(width));
		},
		renderLayout(width = 240): string[] { return [...layout.render(width)]; },
		async command(args = "") {
			const beforeErrors = errors.length;
			await scope.run("command", () => session.prompt(`/gskd-worktree${args ? ` ${args}` : ""}`));
			expect(errors.slice(beforeErrors)).toEqual([]);
		},
		async bash(directory?: string, command = "printf 'REAL_BASH_RECEIPT\\n'", options: { async?: boolean; name?: string; timeout?: number } = {}) {
			const tool = session.agent.state.tools.find(tool => tool.name === "bash");
			if (!tool) throw new Error("SDK did not provide the requested bash tool");
			const id = `location-${++nextCall}`;
			const args = { command, ...options, ...(directory === undefined ? {} : { cwd: directory }) };
			const runner = session.extensionRunner!;
			// Direct SDK tool execution has no agent loop to emit these two outer
			// lifecycle notifications. The real wrapper emits tool_call/result.
			await scope.run("start", () => runner.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: id, args }));
			let result;
			let isError = false;
			try {
				result = await scope.run("end", () => tool.execute(id, args, undefined, update => {
					void runner.emit({ type: "tool_execution_update", toolName: "bash", toolCallId: id, args, partialResult: update });
				}));
				isError = result.isError === true;
			} catch (error) {
				isError = true;
				result = { content: [{ type: "text" as const, text: String(error) }] };
			}
			await scope.run("end", () => runner.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: id, result, isError }));
			return { id, result, isError };
		},
		async writeBash(directory: string, command = "printf 'REAL_XD_BASH_RECEIPT\\n'", options: { async?: boolean; name?: string; timeout?: number } = {}, controls: { id?: string; signal?: AbortSignal; onUpdate?(update: unknown): void } = {}) {
			const tool = session.agent.state.tools.find(tool => tool.name === "write");
			if (!tool) throw new Error("SDK did not provide the requested write transport");
			const id = controls.id ?? `location-xd-${++nextCall}`;
			const args = { path: "xd://bash", content: JSON.stringify({ cwd: directory, command, ...options }) };
			const runner = session.extensionRunner!;
			// Only the outer write has agent-loop lifecycle events. Nested bash
			// must be observed through its real SDK wrapper, without invented events.
			await runner.emit({ type: "tool_execution_start", toolName: "write", toolCallId: id, args });
			let result;
			let isError = false;
			try {
				result = await scope.run("end", () => tool.execute(id, args, controls.signal, update => {
					void runner.emit({ type: "tool_execution_update", toolName: "write", toolCallId: id, args, partialResult: update })
						.then(() => controls.onUpdate?.(update));
				}));
				isError = result.isError === true;
			} catch (error) {
				isError = true;
				result = { content: [{ type: "text" as const, text: String(error) }] };
			}
			await runner.emit({ type: "tool_execution_end", toolName: "write", toolCallId: id, result, isError });
			return { id, result, isError };
		},
		async close() {
			gate.releaseAll();
			for (const hold of receiptHolds) hold.release();
			try { await session.dispose(); } finally {
				server.stop(true); await rm(root, { recursive: true, force: true });
			}
		},
	};
}

async function withFixture(run: (f: LocationFixture) => Promise<void>, options: { deviceBash?: boolean } = {}) {
	const f = await fixture(options);
	try { await run(f); expect(f.errors).toEqual([]); }
	finally { await f.close(); }
}

function expectVisibleLocation(f: LocationFixture, root: string, branch: string) {
	const text = visible(f.render().join("\n"));
	expect(text).toContain(basename(root));
	expect(text).toContain(branch);
}

describe("worktree location through the real SDK and Git worktrees (no model provider required)", () => {
	test("worktree stays right-aligned below input without moving existing rows or adding a blank", () => withFixture(async f => {
		const width = 80;
		const before = f.renderLayout(width).map(visible);
		await f.bash(f.b);
		const after = f.renderLayout(width).map(visible);
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.slice(before.length)).toEqual([expect.stringMatching(/wt:.*checkout-b.*worktree-b$/)]);
		expect(visibleWidth(after.at(-1)!)).toBe(width);
		await f.bash(f.a);
		expect(f.renderLayout(width).map(visible)).toEqual(before);
	}));

	test("unbound execution is observation only, with provenance and a bounded single-line widget", () => withFixture(async f => {
		const receipt = await f.bash(f.b);
		expect(receipt.isError).toBe(false);
		expect(JSON.stringify(receipt.result)).toContain("REAL_BASH_RECEIPT");
		expect(snapshot(f.session)?.expected).toBeNull();
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, source: "bash.cwd", toolCallId: receipt.id,
			git: { root: f.b, branch: "worktree-b" } });
		expectVisibleLocation(f, f.b, "worktree-b");
		expect(visible(f.render().join(""))).not.toMatch(mismatch);
		await f.command("status");
		const detail = f.notices.at(-1)!;
		expect(detail).toContain(f.b);
		expect(detail).toContain(await git(f.b, "rev-parse", "HEAD"));
		expect(detail).toContain("bash.cwd");
		for (const width of [1, 12, 40, 80, 240]) {
			const lines = f.render(width);
			expect(lines.length).toBeLessThanOrEqual(1);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(f.forbiddenUi).toEqual([]);
	}));

	test("a real write xd://bash observes execution and final Git state without nested bash lifecycle events", () => withFixture(async f => {
		const receipt = await f.writeBash(f.b, "git branch -m xd-finished && printf 'REAL_XD_BASH_RECEIPT\\n'");
		expect(receipt.isError).toBe(false);
		expect(toolText(receipt.result)).toContain("REAL_XD_BASH_RECEIPT");
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, source: "bash.cwd", toolCallId: receipt.id,
			phase: "end", git: { root: f.b, branch: "xd-finished", head: await git(f.b, "rev-parse", "HEAD") } });
		expectVisibleLocation(f, f.b, "xd-finished");
		expect(f.dispatches).toBe(0);
		expect(f.wireRequests).toBe(0);
	}, { deviceBash: true }));

	for (const [label, options, error] of [
		["disabled async", { async: true }, "Async bash execution is disabled"],
		["conflicting service options", { name: "rejected-xd-service", timeout: 1 }, "Service mode does not accept async or timeout"],
	] as const) test(`a real write xd://bash ${label} rejection preserves the last executed location`, () => withFixture(async f => {
		const actual = await f.writeBash(f.a);
		expect(actual.isError).toBe(false);
		const previous = structuredClone(snapshot(f.session));
		const previousEntries = f.session.sessionManager.getEntries().length;
		const rejected = await f.writeBash(f.b, "printf 'MUST_NOT_EXECUTE\\n'", options);
		expect(rejected.isError).toBe(true);
		expect(toolText(rejected.result)).toContain(error);
		expect(toolText(rejected.result)).not.toContain("MUST_NOT_EXECUTE");
		expect(snapshot(f.session)).toEqual(previous);
		expect(f.session.sessionManager.getEntries()).toHaveLength(previousEntries);
	}, { deviceBash: true }));

	for (const switchSession of [false, true]) test(`a real xd bash cancelled after stdout ${switchSession ? "cannot write into a new session" : "still records its executed directory"}`, () => withFixture(async f => {
		await f.writeBash(f.a);
		const originalSession = f.session.sessionManager.getSessionId();
		const canonical = f.holdBashReceipt();
		const controller = new AbortController();
		const progress = Promise.withResolvers<unknown>();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
			entered.resolve();
			await released.promise;
			return new Response("released");
		} });
		const script = `await Bun.stdout.write("STARTED_XD_RECEIPT\\n"); await fetch("http://127.0.0.1:${server.port}/");`;
		const pending = f.writeBash(f.b, `${JSON.stringify(process.execPath)} -e '${script}'`, {}, {
			signal: controller.signal,
			onUpdate(update) {
				if (toolText(update).includes("STARTED_XD_RECEIPT")) progress.resolve(update);
			},
		});
		try {
			const [update] = await Promise.all([progress.promise, entered.promise]);
			expect(update).toMatchObject({ details: { xdev: { tool: "bash", mode: "execute" } } });
			if (switchSession) {
				expect(await f.session.newSession()).toBe(true);
				expect(f.session.sessionManager.getSessionId()).not.toBe(originalSession);
			}
			controller.abort();
			const receipt = await pending;
			expect(receipt.isError).toBe(true);
			await canonical.entered;
			canonical.release();
			await canonical.delivered;
			if (switchSession) {
				expect(snapshot(f.session)?.latest ?? null).toBeNull();
				expect(f.render()).toEqual([]);
			} else {
				expect(f.session.sessionManager.getSessionId()).toBe(originalSession);
				expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, source: "bash.cwd", toolCallId: receipt.id,
					phase: "end", git: { root: f.b, branch: "worktree-b" } });
				expectVisibleLocation(f, f.b, "worktree-b");
			}
		} finally {
			controller.abort();
			released.resolve();
			canonical.release();
			try { await pending; } finally { server.stop(true); }
		}
	}, { deviceBash: true }));

	for (const replacement of ["none", "newer"] as const) test(`a silent foreground xd bash receipt delayed past outer cancellation ${replacement === "none" ? "still records canonical input" : "cannot supersede a newer observation"}`, () => withFixture(async f => {
		await f.writeBash(f.a);
		const previous = structuredClone(snapshot(f.session));
		const previousEntries = f.session.sessionManager.getEntries().length;
		const canonical = f.holdBashReceipt();
		f.rewriteNextBash(f.a, f.b);
		const controller = new AbortController();
		const updates: unknown[] = [];
		const pending = f.writeBash(f.a, "true", {}, { signal: controller.signal, onUpdate: update => updates.push(update) });
		try {
			const event = await canonical.entered;
			expect(event.input.cwd).toBe(f.b);
			expect(event.isError).toBe(false);
			expect(updates).toEqual([]);
			controller.abort();
			const outer = await pending;
			expect(outer.isError).toBe(true);
			expect(event.toolCallId).toBe(outer.id);
			expect(snapshot(f.session)).toEqual(previous);
			expect(f.session.sessionManager.getEntries()).toHaveLength(previousEntries);
			let newer: Snapshot | undefined;
			if (replacement === "newer") {
				const current = await f.writeBash(f.other);
				expect(current.isError).toBe(false);
				newer = structuredClone(snapshot(f.session));
			}
			canonical.release();
			await canonical.delivered;
			if (replacement === "none") {
				expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, source: "bash.cwd", toolCallId: outer.id,
					phase: "end", git: { root: f.b, branch: "worktree-b" } });
				expectVisibleLocation(f, f.b, "worktree-b");
			} else {
				expect(snapshot(f.session)).toEqual(newer);
				expectVisibleLocation(f, f.other, "shared-name");
			}
		} finally {
			controller.abort();
			canonical.release();
			await pending;
			await canonical.delivered;
		}
	}, { deviceBash: true }));

	for (const oldRewritten of [false, true]) for (const firstReceipt of ["old", "new"] as const) {
		test(`an ${oldRewritten ? "input-replaced" : "unchanged-input"} old-session canonical receipt delivered ${firstReceipt === "old" ? "before" : "after"} a new same-ID receipt cannot publish old input or consume the new receipt`, () => withFixture(async f => {
			await f.writeBash(f.a);
			const originalSession = f.session.sessionManager.getSessionId();
			const id = "reused-sdk-call-id";
			const oldReceipt = f.holdBashReceipt();
			const oldController = new AbortController();
			if (oldRewritten) f.rewriteNextBash(f.a, f.b);
			const old = f.writeBash(oldRewritten ? f.a : f.b, "true", {}, { id, signal: oldController.signal });
			let current: Promise<{ id: string; result: unknown; isError: boolean }> | undefined;
			let currentReceipt: ReceiptHold | undefined;
			try {
				const oldEvent = await oldReceipt.entered;
				expect(oldEvent.input.cwd).toBe(f.b);
				oldController.abort();
				expect((await old).isError).toBe(true);
				expect(await f.session.newSession()).toBe(true);
				expect(f.session.sessionManager.getSessionId()).not.toBe(originalSession);
				currentReceipt = f.holdBashReceipt();
				current = f.writeBash(f.other, "true", {}, { id });
				const currentEvent = await currentReceipt.entered;
				expect(currentEvent.toolCallId).toBe(oldEvent.toolCallId);
				expect(currentEvent.input.cwd).toBe(f.other);
				if (firstReceipt === "old") {
					oldReceipt.release();
					await oldReceipt.delivered;
					expect(snapshot(f.session)?.latest ?? null).toBeNull();
					currentReceipt.release();
					await currentReceipt.delivered;
				} else {
					currentReceipt.release();
					await currentReceipt.delivered;
					const confirmed = structuredClone(snapshot(f.session));
					oldReceipt.release();
					await oldReceipt.delivered;
					expect(snapshot(f.session)).toEqual(confirmed);
				}
				expect((await current).isError).toBe(false);
				expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.other, source: "bash.cwd", toolCallId: id,
					phase: "end", git: { root: f.other, branch: "shared-name" } });
				expectVisibleLocation(f, f.other, "shared-name");
				if (oldRewritten && firstReceipt === "old") expect(f.notices.at(-1)).toMatch(/ambiguous invocation identity/);
			} finally {
				oldController.abort();
				oldReceipt.release();
				currentReceipt?.release();
				await Promise.all([old, current]);
			}
		}, { deviceBash: true }));
	}

	test("fresh replacement inputs from two same-ID sessions are explicitly ambiguous rather than attributed to the current call", () => withFixture(async f => {
		const id = "indistinguishable-replaced-call-id";
		const oldReceipt = f.holdBashReceipt();
		const oldController = new AbortController();
		f.rewriteNextBash(f.a, f.b);
		const old = f.writeBash(f.a, "true", {}, { id, signal: oldController.signal });
		let currentReceipt: ReceiptHold | undefined;
		let current: Promise<{ id: string; result: unknown; isError: boolean }> | undefined;
		try {
			const oldEvent = await oldReceipt.entered;
			oldController.abort();
			expect((await old).isError).toBe(true);
			expect(await f.session.newSession()).toBe(true);
			currentReceipt = f.holdBashReceipt();
			f.rewriteNextBash(f.a, f.b);
			current = f.writeBash(f.a, "true", {}, { id });
			const currentEvent = await currentReceipt.entered;
			expect(currentEvent.toolCallId).toBe(oldEvent.toolCallId);
			expect(currentEvent.input).toEqual(oldEvent.input);
			expect(currentEvent.input).not.toBe(oldEvent.input);
			currentReceipt.release();
			await currentReceipt.delivered;
			expect((await current).isError).toBe(false);
			expect(snapshot(f.session)?.latest ?? null).toBeNull();
			expect(f.notices.at(-1)).toMatch(/ambiguous invocation identity/);
			oldReceipt.release();
			await oldReceipt.delivered;
			expect(snapshot(f.session)?.latest ?? null).toBeNull();
			expect(f.render()).toEqual([]);
			const identifiable = await f.writeBash(f.other);
			expect(identifiable.isError).toBe(false);
			expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.other, toolCallId: identifiable.id,
				phase: "end", git: { root: f.other } });
		} finally {
			oldController.abort();
			oldReceipt.release();
			currentReceipt?.release();
			await Promise.all([old, current]);
		}
	}, { deviceBash: true }));

	test("terminal shutdown releases receipt ownership and late canonical delivery cannot remount the widget", () => withFixture(async f => {
		await f.writeBash(f.other);
		expectVisibleLocation(f, f.other, "shared-name");
		const canonical = f.holdBashReceipt();
		const controller = new AbortController();
		const pending = f.writeBash(f.b, "true", {}, { signal: controller.signal });
		try {
			await canonical.entered;
			controller.abort();
			expect((await pending).isError).toBe(true);
			await f.session.dispose();
			expect(f.render()).toEqual([]);
			const changes = f.uiChanges;
			canonical.release();
			await canonical.delivered;
			expect(f.render()).toEqual([]);
			expect(f.uiChanges).toBe(changes);
		} finally {
			controller.abort();
			canonical.release();
			await pending;
		}
	}, { deviceBash: true }));

	test("a later extension's direct bash rewrite is recorded from canonical input rather than outer args", () => withFixture(async f => {
		f.rewriteNextBash(f.a, f.b);
		const receipt = await f.bash(f.a, "printf 'REWRITTEN_DIRECT_PWD='; pwd");
		expect(receipt.isError).toBe(false);
		expect(toolText(receipt.result)).toContain(`REWRITTEN_DIRECT_PWD=${f.b}`);
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, toolCallId: receipt.id,
			phase: "end", git: { root: f.b, branch: "worktree-b" } });
	}));

	for (const replacement of ["none", "newer C", "new session"] as const) test(`a canonical A-to-B receipt delayed past outer cancellation ${replacement === "none" ? "ultimately records B" : `cannot supersede ${replacement}`}`, () => withFixture(async f => {
		await f.writeBash(f.a);
		const previous = structuredClone(snapshot(f.session));
		const previousEntries = f.session.sessionManager.getEntries().length;
		const originalSession = f.session.sessionManager.getSessionId();
		const canonical = f.holdBashReceipt();
		f.rewriteNextBash(f.a, f.b);
		const controller = new AbortController();
		const progress = Promise.withResolvers<unknown>();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
			entered.resolve();
			await released.promise;
			return new Response("released");
		} });
		const script = `await Bun.stdout.write("REWRITTEN_XD_PWD=" + process.cwd() + "\\n"); await fetch("http://127.0.0.1:${server.port}/");`;
		const pending = f.writeBash(f.a, `${JSON.stringify(process.execPath)} -e '${script}'`, {}, {
			signal: controller.signal,
			onUpdate(update) {
				if (toolText(update).includes("REWRITTEN_XD_PWD=")) progress.resolve(update);
			},
		});
		try {
			const [update] = await Promise.all([progress.promise, entered.promise]);
			expect(toolText(update)).toContain(`REWRITTEN_XD_PWD=${f.b}`);
			// Transport metadata still describes A even though real stdout proves B.
			expect(update).toMatchObject({ details: { xdev: { tool: "bash", mode: "execute", args: { cwd: f.a } } } });
			expect(snapshot(f.session)).toEqual(previous);
			expect(f.session.sessionManager.getEntries()).toHaveLength(previousEntries);
			expect(visible(f.render().join("\n"))).toMatch(/待确认|pending/i);
			await f.command("status");
			expect(f.notices.at(-1)).toMatch(/待确认|pending/i);
			expect(snapshot(f.session)).toEqual(previous);
			// Let real execution finish, but keep its canonical receipt outside the
			// observer until the cancelled outer write has fully ended.
			released.resolve();
			const event = await canonical.entered;
			expect(event.input.cwd).toBe(f.b);
			expect(toolText(event)).toContain(`REWRITTEN_XD_PWD=${f.b}`);
			controller.abort();
			const outer = await pending;
			expect(outer.isError).toBe(true);
			expect(event.toolCallId).toBe(outer.id);
			expect(snapshot(f.session)).toEqual(previous);
			let newer: Snapshot | undefined;
			if (replacement === "newer C") {
				const current = await f.writeBash(f.other);
				expect(current.isError).toBe(false);
				expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.other, toolCallId: current.id });
				newer = structuredClone(snapshot(f.session));
			} else if (replacement === "new session") {
				expect(await f.session.newSession()).toBe(true);
				expect(f.session.sessionManager.getSessionId()).not.toBe(originalSession);
				expect(snapshot(f.session)?.latest ?? null).toBeNull();
			}
			canonical.release();
			await canonical.delivered;
			if (replacement === "none") {
				expect(f.session.sessionManager.getSessionId()).toBe(originalSession);
				expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, source: "bash.cwd", toolCallId: outer.id,
					phase: "end", git: { root: f.b, branch: "worktree-b" } });
				expectVisibleLocation(f, f.b, "worktree-b");
			} else if (replacement === "newer C") {
				expect(snapshot(f.session)).toEqual(newer);
				expectVisibleLocation(f, f.other, "shared-name");
			} else {
				expect(snapshot(f.session)?.latest ?? null).toBeNull();
				expect(f.render()).toEqual([]);
			}
		} finally {
			controller.abort();
			released.resolve();
			canonical.release();
			try { await pending; await canonical.delivered; } finally { server.stop(true); }
		}
	}, { deviceBash: true }));

	test("a delayed result-only Git probe cannot overwrite a newer write xd://bash observation", () => withFixture(async f => {
		const gate = f.gate.arm(f.a);
		const old = f.writeBash(f.a);
		try {
			await gate.entered;
			const current = await f.writeBash(f.b);
			expect(current.isError).toBe(false);
			expect(snapshot(f.session)?.latest?.toolCallId).toBe(current.id);
		} finally { gate.release(); }
		expect((await old).isError).toBe(false);
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, phase: "end", git: { root: f.b } });
		expectVisibleLocation(f, f.b, "worktree-b");
	}, { deviceBash: true }));

	for (const cancel of [false, true]) test(`a real nested bash receipt ${cancel ? "survives a cancelled" : "cannot cross an accepted"} session switch`, () => withFixture(async f => {
		await f.writeBash(f.a);
		const originalSession = f.session.sessionManager.getSessionId();
		if (cancel) f.cancelSessionSwitch();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
			entered.resolve();
			await released.promise;
			return new Response("released");
		} });
		const script = `await fetch("http://127.0.0.1:${server.port}/"); console.log("INFLIGHT_XD_RECEIPT")`;
		const pending = f.writeBash(f.b, `${JSON.stringify(process.execPath)} -e '${script}'`);
		try {
			await entered.promise;
			expect(await f.session.newSession()).toBe(!cancel);
			if (cancel) expect(f.session.sessionManager.getSessionId()).toBe(originalSession);
			else expect(f.session.sessionManager.getSessionId()).not.toBe(originalSession);
		} finally {
			released.resolve();
			try { await pending; } finally { server.stop(true); }
		}
		const receipt = await pending;
		if (cancel) {
			expect(receipt.isError).toBe(false);
			expect(toolText(receipt.result)).toContain("INFLIGHT_XD_RECEIPT");
			expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, toolCallId: receipt.id,
				phase: "end", git: { root: f.b, branch: "worktree-b" } });
			expectVisibleLocation(f, f.b, "worktree-b");
		} else {
			expect(snapshot(f.session)?.latest ?? null).toBeNull();
			expect(f.render()).toEqual([]);
		}
	}, { deviceBash: true }));

	test("an explicit expected A and an actual worktree B show drift without blocking the tool", () => withFixture(async f => {
		expect(f.render()).toEqual([]);
		await f.command(`set ${f.a}`);
		expect(f.render()).toEqual([]);
		const receipt = await f.bash(f.b);
		expect(receipt.isError).toBe(false);
		expect(JSON.stringify(receipt.result)).toContain("REAL_BASH_RECEIPT");
		expect(snapshot(f.session)?.expected?.root).toBe(f.a);
		expect(snapshot(f.session)?.latest?.git?.root).toBe(f.b);
		expectVisibleLocation(f, f.b, "worktree-b");
		expect(visible(f.render().join(""))).toMatch(mismatch);
		await f.command("status");
		expect(f.notices.at(-1)).toContain(f.a);
		expect(f.notices.at(-1)).toContain(f.b);
		await f.command("clear");
		expectVisibleLocation(f, f.b, "worktree-b");
		await f.bash(f.a);
		expect(f.render()).toEqual([]);
	}));

	test("same-root descendants match, but another root with the same branch name does not", () => withFixture(async f => {
		await f.command(`set ${f.a}`);
		await f.bash(f.subdirectory);
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.subdirectory, git: { root: f.a, branch: "shared-name" } });
		expect(f.render()).toEqual([]);
		await f.bash(f.other);
		expect(snapshot(f.session)?.expected?.branch).toBe(snapshot(f.session)?.latest?.git?.branch!);
		expect(snapshot(f.session)?.latest?.git?.root).toBe(f.other);
		expect(visible(f.render().join(""))).toMatch(mismatch);
	}));

	test("an explicit mismatch stays visible even when actual execution returns to the session workspace", () => withFixture(async f => {
		await f.command(`set ${f.b}`);
		expect(f.render()).toEqual([]);
		await f.bash(f.subdirectory);
		expect(snapshot(f.session)?.latest?.git?.root).toBe(f.a);
		expectVisibleLocation(f, f.a, "shared-name");
		expect(visible(f.render().join(""))).toMatch(mismatch);
	}));

	test("detached HEAD is a real Git location and branch-changing bash refreshes its final state", () => withFixture(async f => {
		await git(f.b, "checkout", "--detach", "-q");
		await f.command(`set ${f.b}`);
		await f.bash(f.b);
		expect(snapshot(f.session)?.expected?.branch).toBeNull();
		expect(snapshot(f.session)?.latest?.git).toMatchObject({ root: f.b, branch: null, head: await git(f.b, "rev-parse", "HEAD") });
		expect(visible(f.render().join(""))).not.toMatch(mismatch);
		await f.bash(f.b, "git checkout -qb after-execution");
		expect(snapshot(f.session)?.latest?.git?.branch).toBe("after-execution");
		expectVisibleLocation(f, f.b, "after-execution");
		await f.command("status");
		expect(f.notices.at(-1)).toContain("after-execution");
	}));

	test("implicit cwd is identified as host cwd and shell cd is never claimed as a tracked directory", () => withFixture(async f => {
		await f.command(`set ${f.a}`);
		await f.bash(undefined, `cd '${f.b}' && printf 'SHELL_INTERNAL_RECEIPT\\n'`);
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.a, source: "ctx.cwd", git: { root: f.a } });
		expect(visible(f.render().join(""))).not.toMatch(mismatch);
		await f.command("status");
		expect(f.notices.at(-1)).toContain("ctx.cwd");
	}));

	for (const [label, options, error] of [
		["disabled async", { async: true }, "Async bash execution is disabled"],
		["conflicting service options", { name: "rejected-service", timeout: 1 }, "Service mode does not accept async or timeout"],
	] as const) test(`${label} rejects before execution without replacing the last real observation`, () => withFixture(async f => {
		const actual = await f.bash(f.a);
		expect(actual.isError).toBe(false);
		const previous = structuredClone(snapshot(f.session));
		const previousEntries = f.session.sessionManager.getEntries().length;
		const rejected = await f.bash(f.b, "printf 'MUST_NOT_EXECUTE\\n'", options);
		expect(rejected.isError).toBe(true);
		expect(JSON.stringify(rejected.result)).toContain(error);
		expect(JSON.stringify(rejected.result)).not.toContain("MUST_NOT_EXECUTE");
		expect(snapshot(f.session)).toEqual(previous);
		expect(f.session.sessionManager.getEntries()).toHaveLength(previousEntries);
	}));

	test("a real nonzero bash exit still records its executed directory", () => withFixture(async f => {
		await f.bash(f.a);
		const receipt = await f.bash(f.b, "printf 'NONZERO_BASH_RECEIPT\\n'; exit 7");
		expect(receipt.isError).toBe(true);
		expect(JSON.stringify(receipt.result)).toContain("NONZERO_BASH_RECEIPT");
		expect(receipt.result).toMatchObject({ details: { exitCode: 7 } });
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, toolCallId: receipt.id,
			phase: "end", git: { root: f.b, branch: "worktree-b" } });
		expectVisibleLocation(f, f.b, "worktree-b");
	}));

	for (const spelling of ["workspace slash", "at-prefixed absolute", "file URL"] as const) {
		test(`${spelling} records the same cwd that real bash pwd reports`, () => withFixture(async f => {
			const directory = spelling === "workspace slash" ? "/" :
				spelling === "at-prefixed absolute" ? `@${f.b}` : pathToFileURL(f.other).href;
			const expected = spelling === "workspace slash" ? f.a : spelling === "at-prefixed absolute" ? f.b : f.other;
			const receipt = await f.bash(directory, "printf 'PWD_RECEIPT='; pwd");
			expect(receipt.isError).toBe(false);
			if (!receipt.result || typeof receipt.result !== "object" || !("content" in receipt.result) ||
				!Array.isArray(receipt.result.content)) throw new Error("Bash did not return SDK content");
			const output = receipt.result.content.flatMap(item => item && typeof item === "object" &&
				item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
			const actual = /PWD_RECEIPT=([^\r\n]+)/.exec(output)?.[1];
			expect(actual).toBe(expected);
			expect(snapshot(f.session)?.latest).toMatchObject({ directory: actual, source: "bash.cwd",
				toolCallId: receipt.id, phase: "end", git: { root: expected } });
		}));
	}

	test("non-Git and deleted paths never acquire a successful matching Git identity", () => withFixture(async f => {
		await f.command(`set ${f.a}`);
		await f.bash(f.plain);
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.plain, git: null });
		expect(visible(f.render().join(""))).toMatch(unknown);
		await f.command(`set ${f.plain}`);
		expect(snapshot(f.session)?.expected?.root).not.toBe(f.plain);
		const deleted = join(f.root, "deleted-checkout");
		await repository(deleted);
		await f.command(`set ${deleted}`);
		await f.bash(deleted);
		expect(snapshot(f.session)?.latest?.git?.root).toBe(deleted);
		await rm(deleted, { recursive: true });
		await f.command("status");
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: deleted, git: null });
		expect(visible(f.render().join(""))).toMatch(unknown);
		await f.command(`set ${deleted}`);
		expect(snapshot(f.session)?.expected?.root).toBe(deleted);
		await f.bash(deleted);
		expect(snapshot(f.session)?.latest?.git?.root).not.toBe(deleted);
	}));

	test("status, binding, clearing and diagnostics never create model messages or requests", () => withFixture(async f => {
		const before = structuredClone(f.session.agent.state.messages);
		await f.command();
		await f.command("status");
		await f.command(`set ${f.a}`);
		await f.bash(f.b);
		await f.command("clear");
		await f.command(`set ${join(f.root, "missing")}`);
		await f.command("not-a-command");
		await f.command("status");
		expect(f.session.agent.state.messages).toEqual(before);
		expect(f.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" ||
			(entry.type === "message" && entry.message.role === "user"))).toEqual([]);
		expect(f.extensionSends).toBe(0);
		expect(f.dispatches).toBe(0);
		expect(f.wireRequests).toBe(0);
	}));

	for (const replacement of ["clear", "set newer"] as const) test(`${replacement} wins over a delayed earlier set query`, () => withFixture(async f => {
		await f.command(`set ${f.other}`);
		const gate = f.gate.arm(f.a);
		const old = f.command(`set ${f.a}`);
		try {
			await gate.entered;
			await f.command(replacement === "clear" ? "clear" : `set ${f.b}`);
		} finally { gate.release(); }
		await old;
		expect(snapshot(f.session)?.expected?.root ?? null).toBe(replacement === "clear" ? null : f.b);
	}));

	test("a newer observed directory wins over a delayed old Git result", () => withFixture(async f => {
		const gate = f.gate.arm(f.a, "end");
		const old = f.bash(f.a);
		try {
			await gate.entered;
			const current = await f.bash(f.b);
			expect(snapshot(f.session)?.latest?.toolCallId).toBe(current.id);
		} finally { gate.release(); }
		await old;
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, git: { root: f.b } });
		expectVisibleLocation(f, f.b, "worktree-b");
	}));

	for (const replacement of ["clear", "set newer"] as const) test(`${replacement} is not undone by a delayed observation query`, () => withFixture(async f => {
		await f.command(`set ${f.a}`);
		const gate = f.gate.arm(f.a, "end");
		const old = f.bash(f.a);
		try {
			await gate.entered;
			await f.command(replacement === "clear" ? "clear" : `set ${f.b}`);
		} finally { gate.release(); }
		await old;
		expect(snapshot(f.session)?.expected?.root ?? null).toBe(replacement === "clear" ? null : f.b);
		expect(snapshot(f.session)?.latest?.git?.root).toBe(f.a);
		if (replacement === "clear") expect(f.render()).toEqual([]);
		else expect(visible(f.render().join(""))).toMatch(mismatch);
	}));

	test("overlapping status refreshes retain the newer branch when the older query finishes first", () => withFixture(async f => {
		const receipt = await f.bash(f.b);
		await git(f.b, "branch", "-m", "status-old");
		// Pause the actual symbolic-ref results, not the earlier root query:
		// each refresh has already read the branch it is meant to publish.
		const olderGate = f.gate.arm(f.b, "command", "symbolic-ref");
		const older = f.command("status");
		let newerGate: QueryHold | undefined;
		let newer: Promise<void> | undefined;
		try {
			await olderGate.entered;
			await git(f.b, "branch", "-m", "status-new");
			newerGate = f.gate.arm(f.b, "command", "symbolic-ref");
			newer = f.command("status");
			await newerGate.entered;
			olderGate.release();
			await older;
			newerGate.release();
			await newer;
		} finally {
			olderGate.release();
			newerGate?.release();
			await Promise.all([older, newer]);
		}
		expect(snapshot(f.session)?.latest).toMatchObject({ toolCallId: receipt.id,
			git: { root: f.b, branch: "status-new" } });
		expectVisibleLocation(f, f.b, "status-new");
		expect(f.notices.at(-1)).toContain("Recent branch: status-new");
	}));

	test("a status query cannot roll a completed execution back to the previous confirmed observation", () => withFixture(async f => {
		await f.bash(f.a);
		const endGate = f.gate.arm(f.b, "end");
		const execution = f.bash(f.b);
		let statusGate: QueryHold | undefined;
		let status: Promise<void> | undefined;
		try {
			await endGate.entered;
			expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.a, phase: "end", git: { root: f.a } });
			statusGate = f.gate.arm(snapshot(f.session)!.latest!.directory, "command");
			status = f.command("status");
			await statusGate.entered;
			endGate.release();
			const receipt = await execution;
			const completed = structuredClone(snapshot(f.session)?.latest);
			expect(completed).toMatchObject({ toolCallId: receipt.id, phase: "end", git: { root: f.b } });
			statusGate.release();
			await status;
			expect(f.notices.at(-1)).toContain(`Recent root: ${JSON.stringify(f.b)}`);
			expectVisibleLocation(f, f.b, "worktree-b");
			expect(snapshot(f.session)?.latest).toEqual(completed);
		} finally {
			endGate.release();
			statusGate?.release();
			await Promise.all([execution, status]);
		}
	}));

	for (const refresh of ["status", "bash"] as const) test(`a host-disposed widget after a cancelled switch restores identical text on ${refresh}`, () => withFixture(async f => {
		await f.bash(f.b);
		const previousText = f.render();
		expectVisibleLocation(f, f.b, "worktree-b");
		expect(f.currentWidget()?.dispose).toBeFunction();
		const originalSession = f.session.sessionManager.getSessionId();
		f.cancelSessionSwitch();
		// The TUI clears and disposes widgets before awaiting a cancellable
		// session transition; a cancelled transition does not remount them.
		f.clearWidgets();
		expect(await f.session.newSession()).toBe(false);
		expect(f.session.sessionManager.getSessionId()).toBe(originalSession);
		expect(f.render()).toEqual([]);
		if (refresh === "status") await f.command("status");
		else await f.bash(f.b);
		expect(f.render()).toEqual(previousText);
	}));

	test("replacing a widget and later disposing the old component cannot invalidate the new display cache", () => withFixture(async f => {
		await f.bash(f.b);
		const old = f.currentWidget()!;
		expect(old.dispose).toBeFunction();
		await f.bash(f.other);
		const current = f.currentWidget()!;
		expect(current).not.toBe(old);
		expectVisibleLocation(f, f.other, "shared-name");
		const changes = f.uiChanges;
		const currentText = f.render();
		// setWidget already disposed old before mounting current. Even a late
		// repeated disposal must not clear current's cached presentation.
		old.dispose?.();
		await f.command("status");
		expect(f.currentWidget()).toBe(current);
		expect(f.render()).toEqual(currentText);
		expect(f.uiChanges).toBe(changes);
	}));

	test("a cancelled before-switch hook preserves an actually running bash observation", () => withFixture(async f => {
		await f.command(`set ${f.a}`);
		await f.bash(f.a);
		f.cancelSessionSwitch();
		const originalSession = f.session.sessionManager.getSessionId();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		// The real bash tool launches Bun, whose HTTP request blocks until the
		// attempted session switch has been cancelled. No execution is mocked.
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
			entered.resolve();
			await released.promise;
			return new Response("released");
		} });
		const script = `await fetch("http://127.0.0.1:${server.port}/"); console.log("INFLIGHT_BASH_RECEIPT")`;
		const pending = f.bash(f.b, `${JSON.stringify(process.execPath)} -e '${script}'`);
		try {
			await entered.promise;
			expect(await f.session.newSession()).toBe(false);
			expect(f.session.sessionManager.getSessionId()).toBe(originalSession);
		} finally {
			released.resolve();
			try { await pending; } finally { server.stop(true); }
		}
		const receipt = await pending;
		expect(receipt.isError).toBe(false);
		expect(JSON.stringify(receipt.result)).toContain("INFLIGHT_BASH_RECEIPT");
		expect(snapshot(f.session)?.expected?.root).toBe(f.a);
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, toolCallId: receipt.id,
			phase: "end", git: { root: f.b, branch: "worktree-b" } });
		expectVisibleLocation(f, f.b, "worktree-b");
	}));

	for (const phase of ["end", "command"] as const) test(`a cancelled before-switch hook preserves an in-flight ${phase} Git query`, () => withFixture(async f => {
		await f.command(`set ${f.a}`);
		await f.bash(f.b);
		await git(f.b, "branch", "-m", "after-cancel");
		f.cancelSessionSwitch();
		const originalSession = f.session.sessionManager.getSessionId();
		const gate = f.gate.arm(f.b, phase, "symbolic-ref");
		const pending = phase === "end" ? f.bash(f.b) : f.command("status");
		try {
			await gate.entered;
			expect(await f.session.newSession()).toBe(false);
			expect(f.session.sessionManager.getSessionId()).toBe(originalSession);
		} finally { gate.release(); await pending; }
		expect(snapshot(f.session)?.expected?.root).toBe(f.a);
		expect(snapshot(f.session)?.latest).toMatchObject({ directory: f.b, phase: "end",
			git: { root: f.b, branch: "after-cancel" } });
		expectVisibleLocation(f, f.b, "after-cancel");
	}));

	test("late queries cannot write state into a new session", () => withFixture(async f => {
		await f.command(`set ${f.a}`);
		const gate = f.gate.arm(f.a, "end");
		const old = f.bash(f.a);
		try {
			await gate.entered;
			expect(await f.session.newSession()).toBe(true);
			await f.command(`set ${f.b}`);
			await f.bash(f.b);
		} finally { gate.release(); }
		await old;
		expect(snapshot(f.session)?.expected?.root).toBe(f.b);
		expect(snapshot(f.session)?.latest?.git?.root).toBe(f.b);
		expectVisibleLocation(f, f.b, "worktree-b");
	}));

	test("tree, branch and session switching restore only their active branch's persisted contract and observation", () => withFixture(async f => {
		await f.command(`set ${f.a}`);
		await f.bash(f.a);
		const leafA = f.session.sessionManager.getLeafId()!;
		const user = f.session.sessionManager.appendMessage({ role: "user", content: "Branch point", timestamp: Date.now() });
		await f.command(`set ${f.b}`);
		await f.bash(f.b);
		const leafB = f.session.sessionManager.getLeafId()!;
		const original = f.session.sessionFile!;
		await f.session.sessionManager.ensureOnDisk();
		expect((await f.session.navigateTree(leafA, { summarize: false })).cancelled).toBe(false);
		expect(snapshot(f.session)?.expected?.root).toBe(f.a);
		expect(f.render()).toEqual([]);
		expect((await f.session.navigateTree(leafB, { summarize: false })).cancelled).toBe(false);
		expect(snapshot(f.session)?.expected?.root).toBe(f.b);
		expectVisibleLocation(f, f.b, "worktree-b");
		expect((await f.session.branch(user)).cancelled).toBe(false);
		const fork = f.session.sessionFile!;
		expect(resolve(fork)).not.toBe(resolve(original));
		expect(snapshot(f.session)?.expected?.root).toBe(f.a);
		expect(snapshot(f.session)?.latest?.git?.root).toBe(f.a);
		expect(f.render()).toEqual([]);
		await f.command("clear");
		await f.session.sessionManager.flush();
		expect(await f.session.switchSession(original)).toBe(true);
		expect(snapshot(f.session)?.expected?.root).toBe(f.b);
		expect(snapshot(f.session)?.latest?.git?.root).toBe(f.b);
		expectVisibleLocation(f, f.b, "worktree-b");
		expect(await f.session.switchSession(fork)).toBe(true);
		expect(snapshot(f.session)?.expected).toBeNull();
		expect(snapshot(f.session)?.latest?.git?.root).toBe(f.a);
		expect(f.render()).toEqual([]);
		expect(f.dispatches).toBe(0);
		expect(f.wireRequests).toBe(0);
	}));
});
