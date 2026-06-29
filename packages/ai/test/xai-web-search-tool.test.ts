import { describe, expect, it } from "vitest";
import { convertResponsesTools } from "../src/api/openai-responses-shared.ts";

// The web_search tool is appended after any function tools.
function webSearchTool(opts: Parameters<typeof convertResponsesTools>[1]) {
	const tools = convertResponsesTools([], opts) as any[];
	return tools.find((t) => t.type === "web_search");
}

describe("Responses web_search tool conversion", () => {
	it("maps blockedDomains to filters.excluded_domains for xAI", () => {
		const tool = webSearchTool({ nativeWebSearch: { blockedDomains: ["reddit.com"] }, provider: "xai" });
		expect(tool).toEqual({ type: "web_search", filters: { excluded_domains: ["reddit.com"] } });
	});

	it("maps allowedDomains to filters.allowed_domains for xAI", () => {
		const tool = webSearchTool({ nativeWebSearch: { allowedDomains: ["x.ai"] }, provider: "xai" });
		expect(tool).toEqual({ type: "web_search", filters: { allowed_domains: ["x.ai"] } });
	});

	it("emits xAI image options", () => {
		const tool = webSearchTool({
			nativeWebSearch: { enableImageUnderstanding: true, enableImageSearch: true },
			provider: "xai",
		});
		expect(tool).toEqual({ type: "web_search", enable_image_understanding: true, enable_image_search: true });
	});

	it("does not send OpenAI-only fields (search_context_size/user_location) to xAI", () => {
		const tool = webSearchTool({
			nativeWebSearch: { searchContextSize: "high", userLocation: { city: "Paris" } },
			provider: "xai",
		});
		expect(tool).toEqual({ type: "web_search" });
	});

	it("throws for xAI when both allowed and blocked domains are set", () => {
		expect(() =>
			webSearchTool({ nativeWebSearch: { allowedDomains: ["a.com"], blockedDomains: ["b.com"] }, provider: "xai" }),
		).toThrow(/not both/);
	});

	it("still rejects blockedDomains for OpenAI (no provider / provider=openai)", () => {
		expect(() => webSearchTool({ nativeWebSearch: { blockedDomains: ["reddit.com"] }, provider: "openai" })).toThrow(
			/does not support blockedDomains/,
		);
		expect(() => webSearchTool({ nativeWebSearch: { blockedDomains: ["reddit.com"] } })).toThrow(
			/does not support blockedDomains/,
		);
	});

	it("keeps OpenAI mapping (allowed_domains + search_context_size + user_location)", () => {
		const tool = webSearchTool({
			nativeWebSearch: { allowedDomains: ["x.com"], searchContextSize: "medium", userLocation: { city: "Paris" } },
			provider: "openai",
		});
		expect(tool).toEqual({
			type: "web_search",
			filters: { allowed_domains: ["x.com"] },
			search_context_size: "medium",
			user_location: {
				type: "approximate",
				city: "Paris",
				country: undefined,
				region: undefined,
				timezone: undefined,
			},
		});
	});
});
