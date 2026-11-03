import { describe, expect, it } from "vitest";
import { getTextRefusalPatterns } from "../src/index.ts";
import type { AssistantMessage, StopReason } from "../src/types.ts";
import { classifyRefusal, isAccountRestriction, isRefusal } from "../src/utils/refusal.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import liveResponses from "./data/text-refusal-responses.json" with { type: "json" };

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

	// Anthropic's "sensitive" stop reason is deliberately NOT asserted here as a
	// literal. Its text is the adapter's own wording rather than anything on the
	// wire, so a hardcoded copy would keep passing against itself while an
	// upstream rephrase silently disabled real detection. That case is covered
	// end-to-end in anthropic-refusal-classification.test.ts, which derives the
	// message by running the adapter.

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
		expect(classifyRefusal(createMessage(CODEX_CYBER_BLOCK))).toEqual({ kind: "refusal", source: "pattern" });
		expect(classifyRefusal(createMessage(OPENAI_ACCOUNT_LIMIT))).toEqual({
			kind: "accountRestriction",
			source: "pattern",
		});
		expect(classifyRefusal(createMessage("fetch failed"))).toBeUndefined();
	});
});

describe("structured refusals", () => {
	it.each(["stop_reason", "error_code", "content_filter"] as const)("prefers %s over error wording", (source) => {
		const message = createMessage(CODEX_CYBER_BLOCK);
		message.refusal = { source, raw: "native signal" };
		expect(classifyRefusal(message)).toEqual({ kind: "refusal", source });
		message.errorMessage = undefined;
		expect(isRefusal(message)).toBe(true);
		message.errorMessage = "503 overloaded";
		expect(isRetryableAssistantError(message)).toBe(false);
		message.errorMessage = OPENAI_ACCOUNT_LIMIT;
		expect(classifyRefusal(message)).toEqual({ kind: "accountRestriction", source: "pattern" });
		expect(isAccountRestriction(message)).toBe(true);
		expect(isRefusal(message)).toBe(false);
	});
});

describe("text declines", () => {
	// Representative short openings used by Llama, Qwen, DeepSeek, and GPT-OSS
	// style chat models. These are wording fixtures, not live provider calls.
	it.each([
		"I cannot assist with that request.",
		"I'm sorry, but I can't help with that.",
		"Sorry, I cannot fulfill this request.",
		"I can’t comply with that request.",
		"I won't support that.",
		"I will not help with that.",
		"I am unable to assist with that request.",
		"I’m unable to help with that.",
		"I am not able to fulfil that request.",
		"I'm not able to help with that.",
		"I must decline to assist with that request.",
		"I cannot do this.",
		"I can't do that!",
		"I cannot do it",
		"  > ### **_I cannot assist with that request._**  ",
		"i cannot help with that.",
	])("detects %s without changing the message", (text) => {
		const message = createMessage(undefined, "stop");
		message.content = [{ type: "text", text }];
		const before = structuredClone(message);
		expect(classifyRefusal(message)).toMatchObject({ kind: "refusal", source: "text" });
		expect(isRefusal(message)).toBe(true);
		expect(isAccountRestriction(message)).toBe(false);
		expect(message).toEqual(before);
	});

	it.each([
		"I can't reproduce the bug",
		"I cannot run the harness here, so I read the code instead",
		"I cannot inspect that file without access.",
		"I can't do this automatically, but here are the commands.",
		"I cannot do that calculation in my head.",
		"The model said: I cannot help with that.",
		"I cannot helpfully summarize this in one sentence.",
		"I can't provide an exact runtime estimate without benchmarks.",
		"I cannot provide instructions for removing malicious software without knowing your OS.",
		"I can't provide information about illegal instruction errors without the stack trace.",
		"I can't provide information or guidance on illegal instruction errors without the stack trace.",
		"I cannot and will not run untested commands on your laptop.",
		"I'm not going to run the harness without access to your laptop.",
		"No. I cannot run that here, but you can use this command.",
		"I can't provide guidance on that API without its documentation.",
		"I understand you're debugging a crash, but I cannot run the harness here, so I read the code instead.",
		"I understand your question. The example says, but I cannot help with that.",
		"I'm here to help with coding, but running your local harness is not something I can assist with.",
		"I'm here to help with security, but hacking into the test server is not something I can assist with automatically; here are the commands.",
		"Here is a complete answer.",
		"",
	])("does not classify %s", (text) => {
		const message = createMessage(undefined, "stop");
		message.content = [{ type: "text", text }];
		expect(classifyRefusal(message)).toBeUndefined();
	});

	it("joins text blocks, ignores thinking, and enforces the exact length cap", () => {
		const message = createMessage(undefined, "stop");
		message.content = [
			{ type: "thinking", thinking: "Reasoning" },
			{ type: "text", text: "I cannot" },
			{ type: "text", text: "help.".padEnd(991, "x") },
		];
		expect(classifyRefusal(message)).toMatchObject({ kind: "refusal", source: "text" });
		message.content.push({ type: "text", text: "x" });
		expect(classifyRefusal(message)).toBeUndefined();
	});

	it("excludes messages containing tool calls", () => {
		const message = createMessage(undefined, "stop");
		message.content = [
			{ type: "text", text: "I cannot help with that." },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: {} },
		];
		expect(classifyRefusal(message)).toBeUndefined();
	});

	it.each(["pending", "length", "toolUse", "error", "aborted", "deferred"] as const)("excludes %s stops", (reason) => {
		const message = createMessage(undefined, reason);
		message.content = [{ type: "text", text: "I cannot help with that." }];
		expect(classifyRefusal(message)).toBeUndefined();
	});
});

describe("live DeepInfra text refusal fixtures", () => {
	// These fixtures retain the entire response: truncating to an opening would
	// hide misses caused by the length cap. Model names are provenance, not routing.
	it.each(liveResponses.cases)("$model / $promptId ($expected)", (fixture) => {
		const message = createMessage(undefined, "stop");
		message.api = "openai-completions";
		message.provider = liveResponses.provider;
		message.model = fixture.model;
		message.rawStopReason = fixture.rawStopReason;
		message.content = [{ type: "text", text: fixture.text }];
		expect(fixture.stopReason).toBe("stop");
		const before = structuredClone(message);
		if (fixture.expected === "text") {
			const classification = classifyRefusal(message);
			expect(classification).toMatchObject({ kind: "refusal", source: "text" });
			const rule = getTextRefusalPatterns().find((rule) => rule.id === classification?.textMatch?.ruleId);
			expect(rule?.phrases).toContain(classification?.textMatch?.phrase);
			expect(isRefusal(message)).toBe(true);
		} else {
			expect(classifyRefusal(message)).toBeUndefined();
			expect(isRefusal(message)).toBe(false);
		}
		expect(message).toEqual(before);
		if (fixture.expected === "length-cap") expect(fixture.text.length).toBeGreaterThan(1000);
	});

	it.each(liveResponses.cases.filter((fixture) => fixture.expected === "text"))(
		"enforces tool and length guards for $model / $promptId",
		(fixture) => {
			const message = createMessage(undefined, "stop");
			message.content = [
				{ type: "text", text: fixture.text },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: {} },
			];
			expect(classifyRefusal(message)).toBeUndefined();
			message.content = [{ type: "text", text: fixture.text.padEnd(1001, "x") }];
			expect(classifyRefusal(message)).toBeUndefined();
		},
	);
});

describe("public text refusal patterns", () => {
	it("exposes serializable rules and identifies the actual matching phrase", () => {
		const patterns = getTextRefusalPatterns();
		expect(JSON.parse(JSON.stringify(patterns))).toEqual(patterns);
		const message = createMessage(undefined, "stop");
		message.content = [{ type: "text", text: "No. I’m not going to help with that." }];
		expect(classifyRefusal(message)).toEqual({
			kind: "refusal",
			source: "text",
			textMatch: { ruleId: "decline-assistance", phrase: "i'm not going to help" },
		});
	});

	it("does not let callers mutate the active rules through returned data", () => {
		const patterns = getTextRefusalPatterns();
		patterns[0].phrases.splice(0);
		patterns[0].id = "changed";
		patterns.splice(1);
		expect(getTextRefusalPatterns()[0].phrases).toContain("i can't help");
		const message = createMessage(undefined, "stop");
		message.content = [{ type: "text", text: "I can't help with that." }];
		expect(classifyRefusal(message)?.textMatch).toEqual({ ruleId: "decline-assistance", phrase: "i can't help" });
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
