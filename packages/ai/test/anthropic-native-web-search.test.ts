import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

interface AnthropicPayload {
	tools?: Array<{ type?: string; name?: string }>;
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

const context: Context = {
	messages: [{ role: "user", content: "what's the weather?", timestamp: Date.now() }],
};

async function capturePayload(nativeTools?: { webSearch?: boolean }): Promise<AnthropicPayload> {
	let captured: AnthropicPayload | undefined;
	const stream = streamSimple(model, context, {
		apiKey: "fake-key",
		nativeTools,
		onPayload: (payload) => {
			captured = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected payload capture before request");
	return captured;
}

describe("Anthropic native web search", () => {
	it("adds a web_search_20250305 tool when nativeTools.webSearch is enabled", async () => {
		const payload = await capturePayload({ webSearch: true });
		expect(payload.tools?.some((t) => t.type === "web_search_20250305" && t.name === "web_search")).toBe(true);
	});

	it("does not add a web search tool when nativeTools is unset", async () => {
		const payload = await capturePayload();
		expect(payload.tools?.some((t) => t.type === "web_search_20250305")).not.toBe(true);
	});
});
