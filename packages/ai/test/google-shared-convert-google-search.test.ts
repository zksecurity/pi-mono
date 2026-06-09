import { describe, expect, it } from "vitest";
import { convertGoogleSearchTool } from "../src/providers/google-shared.ts";

describe("google-shared convertGoogleSearchTool", () => {
	it("returns undefined when web search is disabled", () => {
		expect(convertGoogleSearchTool(undefined)).toBeUndefined();
		expect(convertGoogleSearchTool(false)).toBeUndefined();
	});

	it("returns an empty googleSearch tool when web search is enabled with no options", () => {
		expect(convertGoogleSearchTool(true)).toEqual({ googleSearch: {} });
		expect(convertGoogleSearchTool({})).toEqual({ googleSearch: {} });
	});

	it("maps blockedDomains to excludeDomains", () => {
		expect(convertGoogleSearchTool({ blockedDomains: ["foo.com", "bar.com"] })).toEqual({
			googleSearch: { excludeDomains: ["foo.com", "bar.com"] },
		});
	});

	it("ignores fields Gemini does not support", () => {
		expect(
			convertGoogleSearchTool({
				maxUses: 5,
				searchContextSize: "high",
				userLocation: { city: "Paris" },
			}),
		).toEqual({ googleSearch: {} });
	});

	it("throws when allowedDomains is provided (Gemini has no equivalent)", () => {
		expect(() => convertGoogleSearchTool({ allowedDomains: ["foo.com"] })).toThrowError(/allowedDomains/);
	});
});
