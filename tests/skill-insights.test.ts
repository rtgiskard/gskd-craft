import { describe, expect, test } from "bun:test";
import { buildInsightBatch, identifySkillRead, parseInsightCandidates } from "../extensions/skill-insights";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("insights evidence and coverage", () => {
	test("rejects feedback without evidence or with citations outside the fixed snapshot", () => {
		const candidate = { skill: "gskd-orient", text: "Started implementation before discussing the requested plan", category: "execution", polarity: "correction", evidence: ["entry#0"] };
		expect(parseInsightCandidates(JSON.stringify({ candidates: [candidate] }), new Set(["entry#0"]))[0]).toEqual(candidate);
		expect(() => parseInsightCandidates(JSON.stringify({ candidates: [{ ...candidate, evidence: [] }] }), new Set(["entry#0"])) ).toThrow();
		expect(() => parseInsightCandidates(JSON.stringify({ candidates: [candidate] }), new Set(["other#0"])) ).toThrow();
		expect(parseInsightCandidates('{"candidates":[]}', new Set())).toEqual([]);
	});

	test("large tool output is fully covered across bounded batches, never clipped and marked complete", () => {
		const message = { role: "toolResult", content: [{ type: "text", text: "证据🙂".repeat(32_000) }] };
		const covered = new Set<string>();
		const parts = new Map<number, string>();
		let batches = 0;
		for (;;) {
			const batch = buildInsightBatch([{ id: "large", message }], covered);
			if (!batch.entryIds.length) break;
			expect(batch.bytes).toBeLessThanOrEqual(96_000);
			for (const fragment of batch.selected) parts.set(fragment.part, fragment.text);
			for (const id of batch.entryIds) covered.add(id);
			if (++batches > 100) throw new Error("Coverage failed to advance");
		}
		expect([...parts].sort(([a], [b]) => a - b).map(([, text]) => text).join("")).toBe(JSON.stringify(message));
		expect(buildInsightBatch([{ id: "large", message }], covered).pending).toBe(0);
	});

	test("a new branch reuses common-prefix evidence but still analyzes its distinct messages", () => {
		const common = { id: "common", message: { role: "user", content: "shared context" } };
		const covered = new Set(buildInsightBatch([common, { id: "old", message: "old branch" }], new Set()).entryIds);
		const batch = buildInsightBatch([common, { id: "new", message: "new branch" }], covered);
		expect(batch.entryIds).toEqual(["new#0"]);
		expect(batch.selected.map(fragment => fragment.messageId)).toEqual(["common", "new"]);
	});

	test("raw and reference reads retain one owner even without slash commands or matching directory names", async () => {
		const root = await mkdtemp(join(tmpdir(), "gskd-insights-provenance-"));
		try {
			const directory = join(root, "different-directory-name");
			await mkdir(join(directory, "references"), { recursive: true });
			const source = join(directory, "SKILL.md");
			await writeFile(source, "# Instructions");
			const file = join(directory, "references", "examples.md");
			await writeFile(file, "# Examples");
			const details = (resolvedPath: string, uri: string) => ({ resolvedPath, meta: { source: { type: "internal", value: uri } } });
			expect(await identifySkillRead("skill://review:raw", details(source, "skill://review:raw"), [])).toEqual({ skill: "review", source, file: "skill://review:raw", section: "entry" });
			expect(await identifySkillRead("skill://review/references/examples.md:-5", details(file, "skill://review/references/examples.md:-5"), [])).toEqual({ skill: "review", source, file: "skill://review/references/examples.md:-5", section: "reference" });
			expect(await identifySkillRead("skill://plugin/review/references/examples.md:raw", details(file, "skill://plugin/review/references/examples.md:raw"), [])).toMatchObject({ skill: "plugin/review", source, section: "reference" });
			expect(await identifySkillRead("skill://plugin/review", details(source, "skill://plugin/review"), [
				{ name: "skill:plugin", path: join(root, "other", "SKILL.md") }, { name: "skill:plugin/review", path: source },
			])).toMatchObject({ skill: "plugin/review", source, section: "entry" });
			expect(await identifySkillRead("fake.txt", { resolvedPath: join(root, "fake.txt"), meta: { source: { type: "path", value: join(root, "fake.txt") } } }, [])).toBeUndefined();
			expect(await identifySkillRead("skill://review/references", { ...details(join(directory, "references"), "skill://review/references"), isDirectory: true }, [])).toBeUndefined();
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("filesystem ownership follows the exact entry or deepest directory, not command-name length", async () => {
		const root = await mkdtemp(join(tmpdir(), "gskd-insights-nested-"));
		try {
			const parent = join(root, "SKILL.md");
			const child = join(root, "nested", "SKILL.md");
			const reference = join(root, "nested", "references", "example.md");
			await mkdir(join(root, "nested", "references"), { recursive: true });
			await writeFile(parent, "# Parent");
			await writeFile(child, "# Child");
			await writeFile(reference, "# Reference");
			const commands = [{ name: "skill:very-long-parent-name", path: parent }, { name: "skill:x", path: child }];
			for (const registered of [commands, commands.toReversed()]) {
				for (const [file, skill, source, section] of [
					[parent, "very-long-parent-name", parent, "entry"],
					[child, "x", child, "entry"],
					[reference, "x", child, "reference"],
				]) {
					expect(await identifySkillRead(file!, { resolvedPath: file, meta: { source: { type: "path", value: file } } }, registered))
						.toEqual({ skill, source, file, section });
				}
			}
			// Internal URIs own their registered namespace, independently of the filesystem nesting.
			expect(await identifySkillRead("skill://very-long-parent-name/nested/SKILL.md", {
				resolvedPath: child, meta: { source: { type: "internal", value: "skill://very-long-parent-name/nested/SKILL.md" } },
			}, commands)).toMatchObject({ skill: "very-long-parent-name", source: parent, section: "reference" });
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
