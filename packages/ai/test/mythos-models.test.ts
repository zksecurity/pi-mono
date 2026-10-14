import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";

describe("Claude Mythos 5.1", () => {
	it("is available with official pricing, limits, and always-on adaptive thinking", () => {
		const model = getModel("anthropic", "claude-mythos-5-1");
		expect(model).toMatchObject({
			id: "claude-mythos-5-1",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
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
