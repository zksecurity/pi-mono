import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";

describe.each([
	{
		id: "claude-mythos-5-1",
		cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
	},
	{
		id: "claude-mythos-5-2",
		cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
	},
] as const)("$id", ({ id, cost }) => {
	it("is available with official pricing, limits, and always-on adaptive thinking", () => {
		const model = getModel("anthropic", id);
		expect(model).toMatchObject({
			id,
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			cost,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: {
				forceAdaptiveThinking: true,
				supportsTemperature: false,
				supportsMidConvoEffort: true,
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolChanges: true,
				supportsStrictTools: true,
			},
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});
});
