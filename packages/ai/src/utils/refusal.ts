import type { AssistantMessage } from "../types.ts";

/**
 * Regex patterns to detect *content-scoped* refusals: a provider declined this
 * specific request because of what was in it.
 *
 * These are worth retrying on a different model, because the decision is made
 * per-request by a classifier whose thresholds differ between models. They are
 * NOT worth retrying on the same model — a re-send of the same content earns
 * the same refusal, which is why refusal patterns are deliberately kept out of
 * `RETRYABLE_PROVIDER_ERROR_PATTERN` in `retry.ts`.
 *
 * Detection is string-based, mirroring `overflow.ts`, because refusals reach an
 * `AssistantMessage` by two different routes and only the message text is common
 * to both:
 *
 * 1. Stop-reason mapping — Anthropic reports `stop_reason: "refusal"` and
 *    `openai-completions` reports `finish_reason: "content_filter"`; both are
 *    turned into `stopReason: "error"` plus text by their adapters.
 * 2. A thrown error — `openai-codex-responses` raises `CodexApiError` from
 *    `mapCodexEvents` before any stop reason exists, and the agent's
 *    `handleRunFailure` flattens it to `errorMessage`. A discriminator populated
 *    in the stop-reason mappers would be `undefined` here.
 *
 * Provider-specific patterns (with example error messages):
 *
 * - Anthropic (classifier block, `stop_details.explanation`): "This request
 *   triggered restrictions on violative cyber content and was blocked under
 *   Anthropic's Usage Policy."
 * - Anthropic (no explanation supplied): "The model refused to complete the request"
 * - OpenAI Codex (`CodexApiError`, subscription path): "Codex error: This content
 *   was flagged for possible cybersecurity risk. If this seems wrong, try
 *   rephrasing your request. To get authorized for security work, join the
 *   Trusted Access for Cyber program: https://chatgpt.com/cyber"
 * - OpenAI Responses (metered path): the same sentence with no prefix.
 * - OpenAI Completions: "Provider finish_reason: content_filter"
 *
 * Anthropic's second safety stop reason, `"sensitive"`, is also covered.
 * `mapStopReason` in `api/anthropic-messages.ts` renders it as "Provider stopped
 * with: sensitive", which is adapter wording rather than anything the provider
 * sends — if that string changes, the matching pattern here has to change with
 * it. (Older builds produced `stopReason: "error"` with no message at all, which
 * surfaced as "An unknown error occurred" and was invisible to any classifier.)
 */
const REFUSAL_PATTERNS = [
	// Anthropic safety classifiers.
	/triggered restrictions on violative/i,
	/blocked under anthropic'?s usage policy/i,
	/refused to complete the request/i,
	// Anthropic's other safety stop reason, "sensitive". The wording comes from
	// mapStopReason in api/anthropic-messages.ts, not from the wire.
	/stopped with: sensitive/i,

	// OpenAI / Codex cybersecurity blocks. All three wordings observed in the
	// wild share at least one of these fragments.
	/flagged for possible cybersecurity risk/i,
	/trusted access for cyber/i,
	/chatgpt\.com\/cyber/i,

	// OpenAI-compatible providers surfacing a content filter as a finish reason.
	/\bcontent_filter\b/i,
];

/**
 * Patterns for *account-scoped* restrictions: the credential, not the request,
 * is what the provider objected to.
 *
 * These look superficially like refusals and must not be treated as such.
 * Downgrading the model and retrying on the same credential will fail again —
 * the correct response is to switch credentials or quarantine the account.
 *
 * Example (OpenAI): "This user's access to gpt-5.2-codex has been temporarily
 * limited for potentially suspicious activity related to cybersecurity. Learn
 * more about our safety mitigations:
 * https://platform.openai.com/docs/guides/safety-checks/cybersecurity"
 */
const ACCOUNT_RESTRICTION_PATTERNS = [
	/suspicious activity related to cybersecurity/i,
	/safety-checks\/cybersecurity/i,
	/access to .{1,80} has been temporarily limited/i,
];

function matches(patterns: RegExp[], errorMessage: string): boolean {
	return patterns.some((pattern) => pattern.test(errorMessage));
}

/**
 * Check whether a failed assistant message is a content-scoped refusal that a
 * different model might accept.
 *
 * Returns `false` for account-scoped restrictions ({@link isAccountRestriction}),
 * which are excluded explicitly so a caller that only checks this function never
 * walks a downgrade chain that cannot succeed.
 *
 * ## Custom providers
 *
 * If you use models this repo does not ship patterns for, refusals from them
 * will not be detected. To add support: trigger the refusal, read the resulting
 * `errorMessage`, and add a pattern to `REFUSAL_PATTERNS` in this file — or test
 * the `errorMessage` yourself before calling into a fallback chain.
 */
export function isRefusal(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	if (matches(ACCOUNT_RESTRICTION_PATTERNS, message.errorMessage)) return false;
	return matches(REFUSAL_PATTERNS, message.errorMessage);
}

/**
 * Check whether a failed assistant message reports an account- or
 * credential-scoped restriction rather than a per-request refusal.
 *
 * Callers should treat this as a signal to switch credentials, not models.
 */
export function isAccountRestriction(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	return matches(ACCOUNT_RESTRICTION_PATTERNS, message.errorMessage);
}

/** Mutually exclusive classification of a failed assistant message. */
export type RefusalKind = "refusal" | "accountRestriction";

/**
 * Classify a failed assistant message, or return `undefined` when it is neither
 * a refusal nor an account restriction.
 *
 * Account restrictions are checked first: their wording also mentions
 * cybersecurity, and misreading one as a refusal would send the caller down a
 * downgrade chain that fails at every hop.
 */
export function classifyRefusal(message: AssistantMessage): RefusalKind | undefined {
	if (isAccountRestriction(message)) return "accountRestriction";
	if (isRefusal(message)) return "refusal";
	return undefined;
}

/** Get the content-scoped refusal patterns for testing purposes. */
export function getRefusalPatterns(): RegExp[] {
	return [...REFUSAL_PATTERNS];
}

/** Get the account-scoped restriction patterns for testing purposes. */
export function getAccountRestrictionPatterns(): RegExp[] {
	return [...ACCOUNT_RESTRICTION_PATTERNS];
}
