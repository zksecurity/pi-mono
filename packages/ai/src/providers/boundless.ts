import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { BOUNDLESS_MODELS } from "./boundless.models.ts";

export function boundlessProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "boundless",
		name: "Boundless",
		baseUrl: "https://api.inference.boundless.network/v1",
		auth: { apiKey: envApiKeyAuth("Boundless API key", ["BOUNDLESS_API_KEY"]) },
		models: Object.values(BOUNDLESS_MODELS),
		api: openAICompletionsApi(),
	});
}
