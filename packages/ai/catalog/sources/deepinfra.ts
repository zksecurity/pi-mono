import type { Model } from "../../src/types.ts";

const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";

interface DeepInfraModel {
	id: string;
	metadata?: {
		context_length?: number;
		max_tokens?: number;
		pricing?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_tokens?: number | null;
		};
		tags?: string[];
	};
}

export async function fetchDeepInfraModels(): Promise<Model<"openai-completions">[]> {
	const response = await fetch(`${DEEPINFRA_BASE_URL}/models`);
	if (!response.ok) throw new Error(`DeepInfra API returned ${response.status}`);
	const data = (await response.json()) as { data?: DeepInfraModel[] };
	const models: Model<"openai-completions">[] = [];
	for (const model of Array.isArray(data.data) ? data.data : []) {
		const meta = model.metadata;
		if (!meta) continue;
		const tags = Array.isArray(meta.tags) ? meta.tags : [];
		if (!tags.includes("chat")) continue;
		const contextWindow = meta.context_length || 4096;
		models.push({
			id: model.id,
			name: model.id.split("/").pop() || model.id,
			api: "openai-completions",
			baseUrl: DEEPINFRA_BASE_URL,
			provider: "deepinfra",
			reasoning: tags.includes("reasoning"),
			input: tags.includes("vision") ? ["text", "image"] : ["text"],
			cost: {
				// DeepInfra reports prices per million tokens.
				input: Math.round((meta.pricing?.input_tokens ?? 0) * 1000000) / 1000000,
				output: Math.round((meta.pricing?.output_tokens ?? 0) * 1000000) / 1000000,
				cacheRead: Math.round((meta.pricing?.cache_read_tokens ?? 0) * 1000000) / 1000000,
				cacheWrite: 0,
			},
			contextWindow,
			maxTokens: Math.min(meta.max_tokens || contextWindow, contextWindow),
			compat: { supportsReasoningEffort: tags.includes("reasoning_effort") },
		});
	}
	return models;
}
