import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { XAI_MODELS } from "./xai.models.ts";

// xAI's /v1/responses endpoint is OpenAI-Responses compatible and is the only
// surface that exposes the native `web_search` tool, so Grok runs through the
// openai-responses API rather than chat completions.
export function xaiProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "xai",
		name: "xAI",
		baseUrl: "https://api.x.ai/v1",
		auth: { apiKey: envApiKeyAuth("xAI API key", ["XAI_API_KEY"]) },
		models: Object.values(XAI_MODELS),
		api: openAIResponsesApi(),
	});
}
