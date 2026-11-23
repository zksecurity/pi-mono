import { afterEach, describe, expect, it } from "vitest";
import { getModel, normalizeContext, streamSimple } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types.ts";

const originalBoundlessApiKey = process.env.BOUNDLESS_API_KEY;

afterEach(() => {
	if (originalBoundlessApiKey === undefined) {
		delete process.env.BOUNDLESS_API_KEY;
	} else {
		process.env.BOUNDLESS_API_KEY = originalBoundlessApiKey;
	}
});

async function capturePayload(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions = {},
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	await streamSimple(model, normalizeContext(context), {
		...options,
		apiKey: "test-boundless-key",
		onPayload: (value) => {
			payload = value as Record<string, unknown>;
			throw new Error("payload captured");
		},
	}).result();
	if (payload === undefined) throw new Error("no payload captured");
	return payload;
}

const userOnly: Context = { messages: [{ role: "user", content: "test", timestamp: 0 }] };

describe("Boundless models", () => {
	it("lists the models models.dev does not carry yet with Boundless prices", () => {
		const kimi = getModel("boundless", "moonshotai/kimi-k3.1-pro");
		const flash = getModel("boundless", "deepseek/deepseek-v4.1-flash-1017");

		for (const model of [kimi, flash]) {
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.inference.boundless.network/v1");
			expect(model.reasoning).toBe(true);
		}
		expect(kimi.cost).toEqual({ input: 1.7, output: 8.5, cacheRead: 0.2, cacheWrite: 0 });
		expect(flash.cost).toEqual({ input: 0.24, output: 0.96, cacheRead: 0.0048, cacheWrite: 0 });
		expect(kimi.contextWindow).toBe(1048576);
		expect(flash.maxTokens).toBe(384000);
	});

	it("offers the effort levels Boundless accepts", () => {
		expect(getSupportedThinkingLevels(getModel("boundless", "deepseek/deepseek-v4.1-flash-1017"))).toEqual([
			"off",
			"low",
			"medium",
			"high",
		]);
		expect(getSupportedThinkingLevels(getModel("boundless", "moonshotai/kimi-k3.1-pro"))).toEqual([
			"off",
			"low",
			"high",
		]);
	});

	it.each(["low", "medium", "high"] as const)(
		"sends reasoning_effort %s, max_tokens, and streamed usage to DeepSeek V4.1 Flash 1017",
		async (level) => {
			const model = getModel("boundless", "deepseek/deepseek-v4.1-flash-1017");
			const payload = await capturePayload(model, userOnly, { reasoning: level, maxTokens: 1000 });

			expect(payload.reasoning_effort).toBe(level);
			expect(payload.max_tokens).toBe(1000);
			expect(payload.max_completion_tokens).toBeUndefined();
			expect(payload.stream_options).toEqual({ include_usage: true });
			// Boundless takes native efforts, not DeepSeek's thinking toggle.
			expect(payload.thinking).toBeUndefined();
			expect(payload.store).toBeUndefined();
		},
	);

	it("replays Kimi K3.1 Pro reasoning on assistant turns", async () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "answer" },
			],
			provider: "boundless",
			api: "openai-completions",
			model: "moonshotai/kimi-k3.1-pro",
			timestamp: 0,
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
		const model = getModel("boundless", "moonshotai/kimi-k3.1-pro");
		const payload = await capturePayload(
			model,
			{
				messages: [
					{ role: "user", content: "first", timestamp: 0 },
					assistant,
					{ role: "user", content: "second", timestamp: 0 },
				],
			},
			{ reasoning: "high" },
		);

		const messages = payload.messages as Array<{ role: string; reasoning_content?: string }>;
		expect(messages.find((message) => message.role === "assistant")?.reasoning_content).toBe("internal reasoning");
		expect(payload.reasoning_effort).toBe("high");
	});

	it("resolves BOUNDLESS_API_KEY from the environment", () => {
		process.env.BOUNDLESS_API_KEY = "test-boundless-key";

		expect(findEnvKeys("boundless")).toEqual(["BOUNDLESS_API_KEY"]);
		expect(getEnvApiKey("boundless")).toBe("test-boundless-key");
	});
});
