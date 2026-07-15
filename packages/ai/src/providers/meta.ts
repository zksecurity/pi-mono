import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { META_MODELS } from "./meta.models.ts";

// Meta's Model API exposes Muse Spark through an OpenAI-Responses compatible
// /v1/responses endpoint (it also speaks Chat Completions and the Anthropic
// Messages format). We route through openai-responses because that surface
// carries Muse's agent primitives: parallel tool calls, streamed tool-call
// arguments, search grounding, and cross-turn reasoning. The documented env
// var is MODEL_API_KEY; we also accept the namespaced META_API_KEY first to
// avoid clashing with other providers in a shared environment.
export function metaProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "meta",
		name: "Meta",
		baseUrl: "https://api.meta.ai/v1",
		auth: { apiKey: envApiKeyAuth("Meta Model API key", ["META_API_KEY", "MODEL_API_KEY"]) },
		models: Object.values(META_MODELS),
		api: openAIResponsesApi(),
	});
}
