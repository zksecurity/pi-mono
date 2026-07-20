import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

const MODELS = [
	"zai-org/GLM-5.2",
	"moonshotai/Kimi-K2.7-Code",
	"nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
	"deepseek-ai/DeepSeek-V4-Pro",
	"Qwen/Qwen3.6-35B-A3B",
	"XiaomiMiMo/MiMo-V2.5-Pro",
	"google/gemma-4-26B-A4B-it",
] as const;

function makeContext(): Context {
	return {
		systemPrompt: "You are a precise assistant. Follow the user's instructions exactly.",
		messages: [
			{
				role: "user",
				content: "What is 17 * 3? Reply with exactly the number and nothing else.",
				timestamp: Date.now(),
			},
		],
	};
}

describe.skipIf(!process.env.DEEPINFRA_API_KEY)("DeepInfra smoke", () => {
	for (const modelId of MODELS) {
		it(`streams ${modelId}`, { retry: 2, timeout: 120000 }, async () => {
			const model = getModel("deepinfra", modelId);
			const s = streamSimple(model, makeContext(), { maxTokens: 2048 });

			let text = "";
			for await (const event of s) {
				if (event.type === "text_delta") text += event.delta;
			}

			const response = await s.result();
			expect(response.stopReason, response.errorMessage).toBe("stop");
			expect(response.errorMessage).toBeFalsy();
			expect(text).toContain("51");
		});
	}

	it("calls tools", { retry: 2, timeout: 120000 }, async () => {
		const model = getModel("deepinfra", "deepseek-ai/DeepSeek-V4-Pro");
		const context: Context = {
			systemPrompt: "Use the provided tool when asked about weather.",
			messages: [{ role: "user", content: "What is the weather in Paris?", timestamp: Date.now() }],
			tools: [
				{
					name: "get_weather",
					description: "Get the current weather for a city.",
					parameters: {
						type: "object",
						properties: { city: { type: "string", description: "City name" } },
						required: ["city"],
					},
				},
			],
		};

		const s = streamSimple(model, context, { maxTokens: 1024 });
		for await (const _event of s) {
			// drain
		}

		const response = await s.result();
		const toolCalls = response.content.filter((block) => block.type === "toolCall");
		expect(response.errorMessage).toBeFalsy();
		expect(toolCalls.length).toBeGreaterThan(0);
	});
});
