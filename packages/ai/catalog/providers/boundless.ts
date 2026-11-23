import type { Model } from "../../src/types.ts";
import { addMissing, defineProvider, mergeCompat, modelsDevModels } from "../define.ts";

const BASE_URL = "https://api.inference.boundless.network/v1";

// Boundless serves these models, but models.dev does not list them yet. Prices from
// https://api.inference.boundless.network/v1/model/info (2026-11-06). Limits, input, and effort
// levels follow the models.dev Boundless entries of the earlier releases (kimi-k3, deepseek-v4.1-flash).
const UNLISTED_MODELS: Model<"openai-completions">[] = [
	{
		id: "moonshotai/kimi-k3.1-pro",
		name: "Kimi K3.1 Pro",
		api: "openai-completions",
		provider: "boundless",
		baseUrl: BASE_URL,
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
		input: ["text", "image"],
		cost: { input: 1.7, output: 8.5, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 1048576,
	},
	{
		id: "deepseek/deepseek-v4.1-flash-1017",
		name: "DeepSeek V4.1 Flash 1017",
		api: "openai-completions",
		provider: "boundless",
		baseUrl: BASE_URL,
		reasoning: true,
		// Boundless also accepts medium for this model, unlike the low/high models.dev lists for its predecessor.
		thinkingLevelMap: {
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		},
		input: ["text", "image"],
		cost: { input: 0.24, output: 0.96, cacheRead: 0.0048, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 384000,
	},
];

export default defineProvider({
	id: "boundless",
	models: (ctx) =>
		addMissing(
			modelsDevModels(ctx, "boundless", { api: "openai-completions", baseUrl: BASE_URL }),
			structuredClone(UNLISTED_MODELS),
		),
	// Boundless takes max_tokens; `store` is OpenAI's own parameter.
	compat: { "openai-completions": { supportsStore: false, maxTokensField: "max_tokens" } },
	finalize: (model) => {
		// Kimi K3 and DeepSeek V4 need their earlier reasoning sent back on every host. The DeepSeek family rule
		// does not recognize Boundless's `dsv4` alias for DeepSeek V4 Flash 0731.
		if (model.id.includes("kimi-k3") || model.id === "dsv4") {
			mergeCompat(model as Model<"openai-completions">, { requiresReasoningContentOnAssistantMessages: true });
		}
	},
});
