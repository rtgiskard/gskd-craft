import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { getAgentDir, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { exportSessions } from "./session-export-core";

const help = "Usage: /gskd-export [--all] [--source AGENT_DIR] [--out DIRECTORY] [--stats-only]\nExport a local .tar.zst archive of raw sessions, skill statistics and feedback.\n--stats-only exports only the statistics snapshot. Statistics use the same project/--all scope and never trigger analysis.\nStatistics read failures produce warnings without blocking session export. No archive is created when there are no session files or statistics records.";
const expand = (value: string) => value === "~" ? homedir() : value.startsWith("~/") || value.startsWith("~\\") ? join(homedir(), value.slice(2)) : value;

function words(text: string): string[] {
	const result: string[] = [];
	let word = "", quote = "", started = false;
	for (const char of text) {
		if (quote) {
			if (char === quote) quote = "";
			else word += char;
		} else if (char === '"' || char === "'") { quote = char; started = true; }
		else if (/\s/.test(char)) {
			if (started) { result.push(word); word = ""; started = false; }
		} else { word += char; started = true; }
	}
	if (quote) throw new Error("Unclosed quote in command arguments");
	if (started) result.push(word);
	return result;
}

export default function sessionExport(pi: ExtensionAPI): void {
	let running = false;
	pi.registerCommand("gskd-export", {
		description: "Export raw sessions, skill statistics and feedback to a local tar.zst archive",
		handler: async (args, ctx) => {
			if (running) { ctx.ui.notify("An export is already running.", "warning"); return; }
			try {
				const { values, positionals } = parseArgs({ args: words(args), allowPositionals: true,
					options: { all: { type: "boolean" }, source: { type: "string" }, out: { type: "string" }, "stats-only": { type: "boolean" }, help: { type: "boolean" } } });
				if (values.help) { ctx.ui.notify(help, "info"); return; }
				if (positionals.length) throw new Error(help);
				running = true;
				const session = ctx.sessionManager;
				const sessionId = session.getSessionId();
				ctx.ui.notify("Saving current session before export…", "info");
				// The context type omits the host's public persistence method.
				if (!("ensureOnDisk" in session) || typeof session.ensureOnDisk !== "function" || !session.getSessionFile()) {
					throw new Error("Current session does not support persistent storage; export cancelled.");
				}
				if (session.getEntries().length) await session.ensureOnDisk();
				if (session.getSessionId() !== sessionId) throw new Error("Session changed while saving for export; run the command again.");
				ctx.ui.notify(values["stats-only"] ? "Packing skill statistics locally…" : "Packing raw sessions and skill statistics locally…", "info");
				const result = await exportSessions({
					sourceDir: resolve(ctx.cwd, expand(values.source ?? getAgentDir())),
					sessionDir: values.source || values["stats-only"] ? undefined : ctx.sessionManager.getSessionDir(),
					cwd: ctx.cwd,
					outputDir: resolve(ctx.cwd, expand(values.out ?? process.env.GSKD_EXPORT_DIR ?? join(getAgentDir(), "exports"))),
					all: values.all,
					statsOnly: values["stats-only"],
				});
				ctx.ui.notify(result.message, "info");
				for (const warning of result.warnings) ctx.ui.notify(warning, "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Session export failed", "error");
			} finally { running = false; }
		},
	});
}
