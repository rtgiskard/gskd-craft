import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AgentRegistry, createAgentSession, SessionManager, Settings, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createNoOpUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/utils";
import displayPreset from "../extensions/display-preset";

const setting = (id: string) => {
	const found = lookup(id);
	if (!found) throw new Error(`Missing setting: ${id}`);
	return found;
};

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "gskd-display-"));
	const sessions: AgentSession[] = [];
	const errors: unknown[] = [];
	const model = buildModel({ id: "display", name: "Display test", provider: "gskd-display-test",
		api: "openai-responses", baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"],
		contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	return {
		async create() {
			const settings = Settings.isolated({ "memory.backend": "off", "memories.enabled": false,
				"telemetry.otlpExportEnabled": false, "compaction.enabled": false, "retry.enabled": false });
			const { session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"),
				sessionManager: SessionManager.inMemory(root), settings, model, agentRegistry: new AgentRegistry(),
				bindProcessState: false, hasUI: true, cacheWarming: false, autoTitle: false,
				enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
				toolNames: [], skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
				preloadedCustomToolPaths: [], disableExtensionDiscovery: true, extensions: [displayPreset] });
			sessions.push(session);
			await initializeExtensions(session, { mode: "tui", uiContext: { ...createNoOpUIContext(),
				setWidget() {}, setFooter() {}, setHeader() {}, setWorkingMessage() {}, setTitle() {} },
				reportRuntimeError: error => errors.push(error), reportSendError: (_action, error) => errors.push(error) });
			return { settings, session, async command(action: string) {
				await session.prompt(`/gskd-display ${action}`);
				expect(errors).toEqual([]);
			} };
		},
		async close() {
			try { for (const session of sessions) await session.dispose(); }
			finally { await rm(root, { recursive: true, force: true }); }
		},
	};
}

describe("display preset through the real SDK", () => {
	test("normal restores existing overrides and releases absent ones instead of pinning their old values", async () => {
		const f = await fixture();
		try {
			const a = await f.create();
			setting("display.shimmer").override(a.settings, "kitt");
			setting("display.pinnedAgents").override(a.settings, "full");
			const original = a.settings.overlayLayers();
			await a.command("lite");
			expect(setting("display.shimmer").get(a.settings)).toBe("disabled");
			expect(setting("display.pinnedAgents").get(a.settings)).toBe("collapsed");
			expect(setting("terminal.showImages").get(a.settings)).toBe(false);
			expect(setting("tui.resizeScrollback").get(a.settings)).toBe("preserve");
			await a.command("lite");
			await a.command("normal");
			expect(a.settings.overlayLayers()).toEqual(original);
			setting("tui.resizeScrollback").set(a.settings, "append");
			expect(setting("tui.resizeScrollback").get(a.settings)).toBe("append");
			await a.command("normal");
			expect(setting("display.shimmer").get(a.settings)).toBe("kitt");
		} finally { await f.close(); }
	});

	test("keeps an already hidden agent list hidden and does not undo later user changes", async () => {
		const f = await fixture();
		try {
			const a = await f.create();
			setting("display.pinnedAgents").override(a.settings, "off");
			setting("display.shimmer").override(a.settings, "kitt");
			await a.command("lite");
			expect(setting("display.pinnedAgents").get(a.settings)).toBe("off");
			setting("display.shimmer").override(a.settings, "classic");
			setting("tui.mouse").override(a.settings, true);
			await a.command("normal");
			expect(setting("display.shimmer").get(a.settings)).toBe("classic");
			expect(setting("tui.mouse").get(a.settings)).toBe(true);
			expect(setting("display.pinnedAgents").get(a.settings)).toBe("off");
		} finally { await f.close(); }
	});

	test("scopes commands and shutdown restoration to the correct session even in the same cwd", async () => {
		const f = await fixture();
		try {
			const a = await f.create();
			const b = await f.create();
			const originalA = a.settings.overlayLayers();
			const originalB = b.settings.overlayLayers();
			await a.command("lite");
			expect(b.settings.overlayLayers()).toEqual(originalB);
			await b.command("lite");
			await a.session.extensionRunner!.emit({ type: "session_shutdown" });
			expect(a.settings.overlayLayers()).toEqual(originalA);
			expect(setting("display.shimmer").get(b.settings)).toBe("disabled");
			await b.command("normal");
			expect(b.settings.overlayLayers()).toEqual(originalB);
		} finally { await f.close(); }
	});
});
