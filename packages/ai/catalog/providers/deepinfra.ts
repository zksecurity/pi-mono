import { defineProvider } from "../define.ts";

export default defineProvider({
	id: "deepinfra",
	models: (ctx) => ctx.sources.deepinfra,
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: true,
			supportsLongCacheRetention: false,
			thinkingFormat: "openai",
		},
	},
});
