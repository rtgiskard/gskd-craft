import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, type RpcClientCustomTool } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

type WireRequest = { input?: unknown; [key: string]: unknown };
const extension = fileURLToPath(new URL("../extensions/task-recovery.ts", import.meta.url));
const cli = fileURLToPath(new URL("../../../dist/cli.js", import.meta.resolve("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client")));
const observationMs = 34_500; // Longer than the first production cooldown including jitter.
// This deliberately measures the unmodified CLI's production cooldown. Fake
// timers in the test process cannot control a separate real host process;
// shortening the child clock would stop exercising that platform behavior.

function sse(events: Record<string, unknown>[]): Response {
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
	});
}

function textResponse(text: string, complete = true): Response {
	const item = { id: "msg_local", type: "message", role: "assistant", status: "completed",
		content: [{ type: "output_text", text, annotations: [] }] };
	const events: Record<string, unknown>[] = [
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0,
			part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text },
	];
	if (complete) events.push(
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_local", status: "completed", output: [item],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	);
	// An incomplete response emits visible text before EOF so the provider's own
	// pre-output replay cannot conceal the extension recovery being exercised.
	return sse(events);
}

function toolResponse(op: "effect" | "finish"): Response {
	const item = { id: `fc_${op}`, type: "function_call", call_id: `call_${op}`,
		name: "recovery_artifact", arguments: JSON.stringify({ op }), status: "completed" };
	return sse([
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
		{ type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: `resp_${op}`, status: "completed", output: [item],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	]);
}

async function until(predicate: () => boolean | Promise<boolean>, description: string, timeout = 140_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await Bun.sleep(25);
	}
}

async function fixture(respond: (request: WireRequest, index: number) => Response, tools?: (root: string) => RpcClientCustomTool[]) {
	const root = await mkdtemp(join(tmpdir(), "gskd-recovery-"));
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(home), mkdir(agentDir)]);
	const requests: WireRequest[] = [];
	const serverErrors: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") {
				serverErrors.push(`${request.method} ${request.url}`);
				return new Response("Unexpected endpoint", { status: 400 });
			}
			try {
				const body = await request.json() as WireRequest;
				requests.push(body);
				return respond(body, requests.length);
			} catch (error) {
				serverErrors.push(String(error));
				return new Response("Fixture assertion failed", { status: 400 });
			}
		},
	});
	await writeFile(join(agentDir, "models.yml"), JSON.stringify({ providers: {
		"gskd-local-test": { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-responses", apiKey: "local-not-a-secret",
			models: [{ id: "recovery-test", name: "Local recovery test", reasoning: false, input: ["text"],
				contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
	} }));
	await writeFile(join(agentDir, "config.yml"), JSON.stringify({
		retry: { enabled: false }, compaction: { enabled: false }, providers: { openaiWebsockets: "off" },
		memory: { backend: "off" }, memories: { enabled: false }, telemetry: { otlpExportEnabled: false },
	}));
	let stderr = "";
	const errors: string[] = [];
	const answers: string[] = [];
	const results: Array<{ id?: string; status: string }> = [];
	const client = new RpcClient({
		provider: "gskd-local-test", model: "recovery-test", cwd: root,
		args: ["--no-session", "--no-title", "--no-ui", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-tools",
			"--trusted-extension", extension],
		customTools: tools?.(root),
		spawn(args) {
			// Do not inherit credentials, plugins, parent-agent identity, proxies or
			// global config. No real provider is routable by this child.
			const child = Bun.spawn([process.execPath, cli, ...args], {
				cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDir,
					XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
					XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
					TERM: "dumb", NO_COLOR: "1" },
			});
			const stderrDrain = (async () => {
				for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk);
			})();
			return { stdin: child.stdin, stdout: child.stdout, peekStderr: () => stderr,
				kill: () => child.kill(), exited: child.exited.then(async code => { await stderrDrain; return code; }) };
		},
	});
	client.onPromptResult(result => results.push(result));
	client.onEvent(event => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (event.message.stopReason === "error") errors.push(event.message.errorMessage ?? "unknown error");
			for (const block of event.message.content) if (block.type === "text") answers.push(block.text);
		}
	});
	try { await client.start(); }
	catch (error) { await client.stop(); server.stop(true); await rm(root, { recursive: true, force: true }); throw error; }
	return {
		root, client, requests, errors, answers, serverErrors,
		async command(text: string) {
			const id = await client.prompt(text);
			await until(() => results.some(result => result.id === id), `command ${text}`, 20_000);
			expect(results.find(result => result.id === id)?.status).toBe("completed");
		},
		async close() {
			await client.stop(); server.stop(true);
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("real CLI recovery against loopback Responses SSE (no paid provider)", () => {
	test.concurrent("survives two failures around one committed side effect and preserves its receipt", async () => {
		let effectCalls = 0;
		let finishCalls = 0;
		const f = await fixture((request, index) => {
			if (index === 1 || index === 3) return textResponse(`partial-before-drop-${index}`, false);
			if (index === 2) return toolResponse("effect");
			if (index === 4) {
				expect(JSON.stringify(request.input)).toContain("side-effect-receipt");
				return toolResponse("finish");
			}
			if (index === 5) return textResponse("RECOVERY_COMPLETE");
			throw new Error(`Duplicate or unexpected model request ${index}`);
		}, root => [{ name: "recovery_artifact", label: "Recovery artifact", description: "Commit the requested local test artifact",
			parameters: { type: "object", properties: { op: { type: "string", enum: ["effect", "finish"] } }, required: ["op"], additionalProperties: false },
			async execute(params) {
				if (params.op === "effect") {
					effectCalls++;
					await appendFile(join(root, "effects.log"), "committed\n");
					return "side-effect-receipt";
				}
				if (params.op !== "finish") throw new Error("Unexpected operation");
				finishCalls++;
				await writeFile(join(root, "completed.json"), JSON.stringify({ completed: true, effectCalls }));
				return "completion-artifact-receipt";
			} }] );
		try {
			await f.client.prompt("Perform the task, commit the effect exactly once, then finish the artifact.");
			await until(() => f.errors.length === 1, "first real failed model stream");
			const before = await f.client.getMessages();
			await f.command("/gskd-recovery status");
			expect(f.requests).toHaveLength(1);
			expect(await f.client.getMessages()).toEqual(before);
			await until(() => f.answers.includes("RECOVERY_COMPLETE"), "automatic second recovery and final answer");
			await until(async () => !(await f.client.getState()).isStreaming, "final turn settlement");
			expect(f.errors).toHaveLength(2);
			expect(f.requests).toHaveLength(5);
			expect(effectCalls).toBe(1);
			expect(finishCalls).toBe(1);
			expect(await readFile(join(f.root, "effects.log"), "utf8")).toBe("committed\n");
			expect(JSON.parse(await readFile(join(f.root, "completed.json"), "utf8"))).toEqual({ completed: true, effectCalls: 1 });
			const messages = await f.client.getMessages();
			expect(messages.filter(message => message.role === "custom" && message.customType === "gskd-recovery")).toHaveLength(2);
			expect(f.serverErrors).toEqual([]);
		} finally { await f.close(); }
	}, 180_000);

	for (const action of ["off", "new input"] as const) test.concurrent(`${action} invalidates the old pending recovery`, async () => {
		const f = await fixture((_request, index) => index === 1 ? textResponse("partial old task", false) : textResponse("NEW_INPUT_COMPLETE"));
		try {
			await f.client.prompt("Old task");
			await until(() => f.errors.length === 1, "old task failure");
			if (action === "off") await f.command("/gskd-recovery off");
			else {
				await f.client.prompt("Replace old task with this new task");
				await until(() => f.answers.includes("NEW_INPUT_COMPLETE"), "new input response");
			}
			await Bun.sleep(observationMs);
			expect(f.requests).toHaveLength(action === "off" ? 1 : 2);
			expect((await f.client.getMessages()).filter(message => message.role === "custom" && message.customType === "gskd-recovery")).toHaveLength(0);
			expect(f.serverErrors).toEqual([]);
		} finally { await f.close(); }
	}, 70_000);

	test.concurrent("hard provider errors and repeated status commands never wake a model", async () => {
		const f = await fixture(() => Response.json({ error: { type: "invalid_request_error", code: "invalid_api_key", message: "invalid API key" } }, { status: 401 }));
		try {
			await f.command("/gskd-recovery status");
			expect(f.requests).toHaveLength(0);
			await f.client.prompt("Task with a hard provider error");
			await until(() => f.errors.length === 1, "hard provider error");
			const before = await f.client.getMessages();
			await f.command("/gskd-recovery status");
			await f.command("/gskd-recovery status");
			await Bun.sleep(observationMs);
			expect(f.requests).toHaveLength(1);
			expect(await f.client.getMessages()).toEqual(before);
			expect(f.serverErrors).toEqual([]);
		} finally { await f.close(); }
	}, 70_000);
});
