import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup, type AnySetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { findScopedSettings, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const preset = {
	"terminal.showImages": false,
	"display.shimmer": "disabled",
	"display.pinnedAgents": "collapsed",
	"display.subagentLivePreview": false,
	"tui.resizeScrollback": "preserve",
} as const;

type Change = { setting: AnySetting; previous: unknown; applied: unknown };

export default function displayPreset(pi: ExtensionAPI): void {
	let active: { settings: Settings; changes: Change[] } | undefined;

	function restore(): void {
		if (!active) return;
		const { settings, changes } = active;
		active = undefined;
		for (const { setting, previous, applied } of changes) {
			// A later user change belongs to the user, not this preset.
			if (setting.get(settings) !== applied) continue;
			if (previous === undefined) setting.clearOverride(settings);
			else setting.override(settings, previous);
		}
	}

	pi.on("session_shutdown", restore);
	pi.registerCommand("gskd-display", {
		description: "Runtime display preset: lite | normal | status",
		handler: async (args, ctx) => {
			if (ctx.agent.kind !== "main" || ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("gskd-display requires the main TUI session.", "warning");
				return;
			}
			const action = args.trim() || "status";
			if (!["lite", "normal", "status"].includes(action)) {
				ctx.ui.notify("Usage: /gskd-display [lite | normal | status]", "warning");
				return;
			}
			const settings = findScopedSettings(ctx.cwd);
			if (!settings) throw new Error("No active session settings for gskd-display");
			if (active && active.settings !== settings) restore();
			if (action === "lite" && !active) {
				const overrides = settings.overlayLayers().overrides;
				// Resolve and validate the whole preset before changing any setting.
				const changes = Object.entries(preset).map(([id, requested]): Change => {
					const setting = lookup(id);
					if (!setting || !setting.accepts(requested)) throw new Error(`Unsupported display setting: ${id}`);
					const applied = id === "display.pinnedAgents" && setting.get(settings) === "off" ? "off" : requested;
					let previous: unknown = overrides;
					for (const part of setting.segments) {
						previous = previous && typeof previous === "object"
							? (previous as Record<string, unknown>)[part] : undefined;
					}
					return { setting, previous, applied };
				});
				active = { settings, changes };
				try {
					for (const { setting, applied } of changes) setting.override(settings, applied);
				} catch (error) {
					restore();
					throw error;
				}
			} else if (action === "normal") restore();
			ctx.ui.notify(active
				? "Display: lite (images and shimmer off; agent previews collapsed; resize preserves history). Execution spinners and timers remain."
				: "Display: normal (preset overrides released; existing settings retained).", "info");
		},
	});
}
