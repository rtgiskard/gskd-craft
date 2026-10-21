import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";

export interface RecoveryFailure {
	kind: "transient" | "suspected";
	reason: string;
	retryAfterMs?: number;
}

const HARD_FAILURE = /\b(?:insufficient[_ -]?(?:quota|credits|balance)|quota[_ -]?(?:exhausted|exceeded)|billing|payment required|credit balance|invalid[_ -]?(?:api[_ -]?key|request|argument)|unsupported[_ -]?(?:model|parameter)|model[_ -]?not[_ -]?found|permission denied|certificate (?:has expired|verify failed)|self[- ]signed certificate|failed to parse tool call arguments)\b/i;
const TRANSPORT_FAILURE = /\b(?:upstream[_ -]http2[_ -]stream[_ -]error|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|fetch failed|failed to fetch|network (?:error|connection.*lost)|socket hang up|connection (?:reset|refused|closed|terminated)|broken pipe|stream (?:closed|ended) before (?:a terminal response event|response\.completed|completion)|responses stream closed before a terminal response event|unexpected eof|incomplete chunked read|http\/?2 stream (?:error|reset)|RST_STREAM)\b/i;
const SUSPECTED_TRANSPORT = /\b(?:upstream (?:error|failure)|stream (?:error|failure)|transport (?:error|failure)|premature (?:close|end))\b/i;

/** The host classifier mutates its argument; never hand it a transcript message. */
export function classifyFailure(message: AssistantMessage): RecoveryFailure | undefined {
	if (message.stopReason !== "error") return undefined;
	// Core has a changed-request recovery for this 408; identical extension turns
	// must not bypass its explicit terminal decision when that route is exhausted.
	if (AIError.isResponsesRequestBodyReadTimeout(message)) return undefined;
	const id = AIError.classifyMessage({ ...message });
	const text = message.errorClassificationMessage ?? message.errorMessage ?? "";
	const status = message.errorStatus ?? (id >= 400 && id <= 599 ? id : AIError.status({ message: text }));
	const hardFlags = [
		AIError.Flag.AuthFailed, AIError.Flag.OAuthExpiry, AIError.Flag.AccountPolicy,
		AIError.Flag.ContentBlocked, AIError.Flag.ContextOverflow, AIError.Flag.PayloadRejected,
		AIError.Flag.Grammar, AIError.Flag.FastModeUnsupported, AIError.Flag.CacheControlUnsupported,
		AIError.Flag.MalformedFunctionCall, AIError.Flag.ThinkingLoop, AIError.Flag.StaleResponsesItem,
		AIError.Flag.Abort, AIError.Flag.UserInterrupt, AIError.Flag.SilentAbort,
		AIError.Flag.EmptyResponse,
	];
	if (hardFlags.some(flag => AIError.is(id, flag)) || HARD_FAILURE.test(text)) return undefined;
	if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) return undefined;
	const retryHint = extractProviderRetryHint(message.provider, text);
	const retryAfterMs = retryHint !== undefined && Number.isFinite(retryHint) && retryHint >= 0 ? retryHint : undefined;
	// A quota/account cap is not a temporary request throttle. Core credential recovery owns it.
	if (AIError.is(id, AIError.Flag.UsageLimit) && status !== 429) return undefined;
	if (AIError.isUsageLimit(text, message.api) && /quota|credits?|billing|balance|usage limit/i.test(text)) return undefined;
	if (
		status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599) ||
		(AIError.retriable(id) && (AIError.is(id, AIError.Flag.Transient) || AIError.is(id, AIError.Flag.Timeout))) ||
		TRANSPORT_FAILURE.test(text) || AIError.isTransientStreamDropError(text) || AIError.isTransientStreamParseError(text)
	) return { kind: "transient", reason: "temporary upstream/transport failure", retryAfterMs };
	if (SUSPECTED_TRANSPORT.test(text)) return { kind: "suspected", reason: "unconfirmed upstream/transport failure", retryAfterMs };
	return undefined;
}

/** Positive jitter never shortens the provider's requested minimum wait. */
export function recoveryDelay(attempt: number, retryAfterMs = 0, random = Math.random): number {
	const base = [30_000, 60_000, 120_000, 300_000][Math.min(Math.max(attempt - 1, 0), 3)];
	return Math.max(Math.round(base * (1 + random() * 0.1)), retryAfterMs);
}
