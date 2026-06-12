import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/stream.ts";
import type { AssistantMessage, Context, Model, ThinkingContent } from "../src/types.ts";

interface AnthropicPayload {
	messages?: Array<{
		role: string;
		content: Array<{ type: string; text?: string; thinking?: string; signature?: string }>;
	}>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 1024,
};

function makeContext(thinkingBlocks: ThinkingContent[]): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [...thinkingBlocks, { type: "text", text: "let me check" }],
		provider: "anthropic",
		api: "anthropic-messages",
		model: "claude-opus-4-8",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
	return {
		messages: [
			{ role: "user", content: "first", timestamp: Date.now() },
			assistant,
			{ role: "user", content: "second", timestamp: Date.now() },
		],
	};
}

async function capturePayload(context: Context): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const stream = streamSimple(model, context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!capturedPayload) throw new Error("Expected payload capture before request");
	return capturedPayload;
}

describe("Anthropic signed empty thinking blocks", () => {
	it("echoes back a signed thinking block with empty text", async () => {
		// Adaptive thinking can emit a signed block whose summary text is empty;
		// the API requires it back verbatim or rejects the request with a 400.
		const payload = await capturePayload(
			makeContext([{ type: "thinking", thinking: "", thinkingSignature: "sig-abc" }]),
		);
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual([
			{ type: "thinking", thinking: "", signature: "sig-abc" },
			{ type: "text", text: "let me check" },
		]);
	});

	it("still drops unsigned thinking blocks with empty text", async () => {
		const payload = await capturePayload(makeContext([{ type: "thinking", thinking: " ", thinkingSignature: "" }]));
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual([{ type: "text", text: "let me check" }]);
	});
});
