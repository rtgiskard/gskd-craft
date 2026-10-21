import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { classifyFailure, recoveryDelay } from "../extensions/recovery-policy";

function failure(errorMessage: string, errorStatus?: number): AssistantMessage {
	return {
		role: "assistant", api: "openai-responses", provider: "s2-inc", model: "local-test",
		content: [], stopReason: "error", timestamp: 1, errorMessage, errorStatus,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

describe("recovery policy consumer behavior", () => {
	for (const text of [
		"upstream_http2_stream_error",
		"OpenAI responses stream closed before a terminal response event was received",
		"fetch failed: ECONNRESET",
		"socket hang up",
	]) test(`recovers a real transport failure: ${text}`, () => {
		const message = failure(text);
		const before = structuredClone(message);
		expect(classifyFailure(message)?.kind).toBe("transient");
		expect(message).toEqual(before);
	});

	for (const status of [408, 429, 500, 502, 503, 504]) {
		test(`recovers temporary HTTP ${status}`, () => {
			expect(classifyFailure(failure("temporary service failure", status))?.kind).toBe("transient");
		});
	}

	for (const [text, status] of [
		["invalid_api_key", 401], ["permission denied", 403], ["model_not_found", 404],
		["invalid_request_error", 400], ["insufficient_quota", 429],
		["billing credit balance exhausted", 429], ["certificate verify failed", undefined],
		["failed to parse tool call arguments", undefined],
	] as const) test(`does not turn hard failures into model traffic: ${text}`, () => {
		expect(classifyFailure(failure(text, status))).toBeUndefined();
	});

	test("successful and deliberately aborted turns never arm recovery", () => {
		for (const stopReason of ["stop", "toolUse", "aborted"] as const) {
			expect(classifyFailure({ ...failure("ECONNRESET"), stopReason })).toBeUndefined();
		}
	});

	test("does not bypass the host's exhausted changed-request 408 recovery", () => {
		const exhausted = { ...failure("timed out reading request body", 408), requestBodyReadTimeoutFullReplay: true };
		expect(classifyFailure(exhausted)).toBeUndefined();
		expect(classifyFailure(failure("timed out reading request body", 408))?.kind).toBe("transient");
	});

	test("thought-only output is not a communication failure even when the SDK calls it retriable", () => {
		expect(classifyFailure(failure("thought-only response without final output"))).toBeUndefined();
	});

	test("suspected transport failures remain distinguishable from confirmed transport failures", () => {
		expect(classifyFailure(failure("upstream failure"))?.kind).toBe("suspected");
		expect(classifyFailure(failure("unrelated application bug"))).toBeUndefined();
	});

	test("repeated failures retain finite bounded cooldowns and honor server minimum waits", () => {
		const delays = [1, 2, 3, 4, 99, Number.MAX_SAFE_INTEGER].map(attempt => recoveryDelay(attempt, 0, () => 0.5));
		for (const delay of delays) {
			expect(Number.isFinite(delay)).toBe(true);
			expect(delay).toBeGreaterThan(0);
			expect(delay).toBeLessThanOrEqual(2_147_483_647);
		}
		expect(delays.at(-1)).toBe(delays.at(-2));
		for (const jitter of [0, 0.5, 1]) {
			expect(recoveryDelay(1, 90_000, () => jitter)).toBeGreaterThanOrEqual(90_000);
		}
	});
});
