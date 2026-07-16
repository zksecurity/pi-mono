import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, ToolResultMessage, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Assistant turn carrying a reasoning item and a paired fc_ tool call, as Muse emits.
function conversation(): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: "rs_aaaa:rs_bbbb",
					encrypted_content: "enc-blob",
					summary: [],
				}),
			},
			{ type: "toolCall", id: "call_123|fc_123", name: "get_weather", arguments: { city: "Paris" } },
		],
		api: "openai-responses",
		provider: "meta",
		model: "muse-spark-1.1",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now() - 2000,
	};
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_123|fc_123",
		toolName: "get_weather",
		content: [{ type: "text", text: "18C" }],
		isError: false,
		timestamp: Date.now() - 1000,
	};
	return {
		messages: [{ role: "user", content: "weather in Paris?", timestamp: Date.now() - 3000 }, assistant, toolResult],
	};
}

const PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

describe("Meta Muse reasoning replay compat", () => {
	it("omits reasoning items and drops the paired fc_ id when replayReasoning is false", () => {
		const model = getModel("meta", "muse-spark-1.1");
		const input = convertResponsesMessages(model, conversation(), PROVIDERS, { replayReasoning: false });

		expect(input.some((item) => item.type === "reasoning")).toBe(false);
		const fc = input.find((item) => item.type === "function_call");
		expect(fc).toBeDefined();
		if (!fc || fc.type !== "function_call") throw new Error("expected function_call");
		expect(fc.id).toBeUndefined();
		expect(fc.call_id).toBe("call_123");
	});

	it("replays reasoning items and keeps the fc_ id by default (stateless contract)", () => {
		const model = getModel("meta", "muse-spark-1.1");
		const input = convertResponsesMessages(model, conversation(), PROVIDERS);

		const reasoning = input.find((item) => item.type === "reasoning");
		expect(reasoning).toBeDefined();
		expect((reasoning as { id?: string } | undefined)?.id).toBe("rs_aaaa:rs_bbbb");
		const fc = input.find((item) => item.type === "function_call");
		if (!fc || fc.type !== "function_call") throw new Error("expected function_call");
		expect(fc.id).toBe("fc_123");
	});
});
