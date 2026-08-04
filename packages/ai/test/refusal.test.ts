import { describe, expect, it } from "vitest";
import type { AssistantMessage, StopReason } from "../src/types.ts";
import { classifyRefusal, isAccountRestriction, isRefusal } from "../src/utils/refusal.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

function createMessage(errorMessage?: string, stopReason: StopReason = "error"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.6-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

// Verbatim wordings observed in production. Keep these exact — they are the
// contract this classifier exists to satisfy.
const CODEX_CYBER_BLOCK =
	"Codex error: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber";
const OPENAI_CYBER_BLOCK =
	"This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber";
const OPENAI_ACCOUNT_LIMIT =
	"This user's access to gpt-5.2-codex has been temporarily limited for potentially suspicious activity related to cybersecurity. Learn more about our safety mitigations: https://platform.openai.com/docs/guides/safety-checks/cybersecurity";
const ANTHROPIC_CYBER_REFUSAL =
	"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback";

describe("isRefusal", () => {
	it("detects the Codex subscription-path cybersecurity block", () => {
		expect(isRefusal(createMessage(CODEX_CYBER_BLOCK))).toBe(true);
	});

	it("detects the metered OpenAI cybersecurity block with no prefix", () => {
		expect(isRefusal(createMessage(OPENAI_CYBER_BLOCK))).toBe(true);
	});

	it("detects the Anthropic classifier refusal explanation", () => {
		expect(isRefusal(createMessage(ANTHROPIC_CYBER_REFUSAL))).toBe(true);
	});

	it("detects the Anthropic fallback wording when no explanation is supplied", () => {
		expect(isRefusal(createMessage("The model refused to complete the request"))).toBe(true);
	});

	it("detects an openai-completions content filter finish reason", () => {
		expect(isRefusal(createMessage("Provider finish_reason: content_filter"))).toBe(true);
	});

	it("detects the Anthropic sensitive-content stop reason", () => {
		// This exact string is produced by mapStopReason in api/anthropic-messages.ts
		// for stop_reason "sensitive". Keep the two in sync: before it had an
		// errorMessage at all, this case surfaced as "An unknown error occurred"
		// and no classifier could see it.
		expect(isRefusal(createMessage("The model refused to complete the request (content flagged as sensitive)"))).toBe(
			true,
		);
	});

	it("does not treat an account-scoped restriction as a refusal", () => {
		expect(isRefusal(createMessage(OPENAI_ACCOUNT_LIMIT))).toBe(false);
	});

	it("ignores unrelated provider errors", () => {
		expect(isRefusal(createMessage("529 overloaded_error: Overloaded"))).toBe(false);
		expect(isRefusal(createMessage("prompt is too long: 213462 tokens > 200000 maximum"))).toBe(false);
	});

	it("ignores non-error and message-less responses", () => {
		expect(isRefusal(createMessage(CODEX_CYBER_BLOCK, "stop"))).toBe(false);
		expect(isRefusal(createMessage(undefined))).toBe(false);
	});
});

describe("isAccountRestriction", () => {
	it("detects the account-level cybersecurity limitation", () => {
		expect(isAccountRestriction(createMessage(OPENAI_ACCOUNT_LIMIT))).toBe(true);
	});

	it("does not fire on per-request refusals", () => {
		expect(isAccountRestriction(createMessage(CODEX_CYBER_BLOCK))).toBe(false);
		expect(isAccountRestriction(createMessage(ANTHROPIC_CYBER_REFUSAL))).toBe(false);
	});
});

describe("classifyRefusal", () => {
	it("separates the two cybersecurity-worded failures", () => {
		expect(classifyRefusal(createMessage(CODEX_CYBER_BLOCK))).toBe("refusal");
		expect(classifyRefusal(createMessage(OPENAI_ACCOUNT_LIMIT))).toBe("accountRestriction");
		expect(classifyRefusal(createMessage("fetch failed"))).toBeUndefined();
	});
});

describe("refusals stay out of the transient-retry classifier", () => {
	// Re-sending refused content to the model that refused it earns the same
	// refusal. Refusal is a fallback trigger, never a retry trigger.
	it.each([
		["codex cyber block", CODEX_CYBER_BLOCK],
		["openai cyber block", OPENAI_CYBER_BLOCK],
		["anthropic classifier refusal", ANTHROPIC_CYBER_REFUSAL],
		["openai account limitation", OPENAI_ACCOUNT_LIMIT],
	])("%s is not retryable", (_label, errorMessage) => {
		expect(isRetryableAssistantError(createMessage(errorMessage))).toBe(false);
	});

	// Refusals are marked non-retryable positively, so an incidental status code
	// or transport word in the body cannot flip them back to retryable.
	it.each([
		["400-prefixed codex block", `400 ${CODEX_CYBER_BLOCK}`],
		["429-prefixed cyber block", `429 ${OPENAI_CYBER_BLOCK}`],
		["503-prefixed anthropic refusal", `503 ${ANTHROPIC_CYBER_REFUSAL}`],
		["429-prefixed account limitation", `429 ${OPENAI_ACCOUNT_LIMIT}`],
		[
			"content filter inside a 429 body",
			'429 {"error":{"code":"content_filter","message":"The response was filtered"}}',
		],
	])("%s stays non-retryable despite an embedded status code", (_label, errorMessage) => {
		expect(isRetryableAssistantError(createMessage(errorMessage))).toBe(false);
	});

	it("does not retry a usage limit reported as a 429 error type", () => {
		// The "429" in the body used to match RETRYABLE_PROVIDER_ERROR_PATTERN and
		// the account limit was retried until the budget ran out.
		const message = createMessage('429 {"error":{"type":"usage_limit_reached","message":"Usage limit reached"}}');
		expect(isRetryableAssistantError(message)).toBe(false);
	});

	it("still retries genuinely transient errors", () => {
		expect(isRetryableAssistantError(createMessage("529 overloaded_error: Overloaded"))).toBe(true);
		expect(isRetryableAssistantError(createMessage("429 rate_limit_error: slow down"))).toBe(true);
		expect(isRetryableAssistantError(createMessage("fetch failed"))).toBe(true);
	});
});
