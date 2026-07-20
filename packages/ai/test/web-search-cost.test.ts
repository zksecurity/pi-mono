import { describe, expect, it } from "vitest";
import { computeWebSearchCost } from "../src/api/openai-responses-shared.ts";

const search = { type: "web_search_call", action: { type: "search" } };
const openPage = { type: "web_search_call", action: { type: "open_page" } };
const noAction = { type: "web_search_call" };
const message = { type: "message" };

describe("computeWebSearchCost", () => {
	it("prices xAI web search at $0.005/call", () => {
		expect(computeWebSearchCost([search, search], "xai")).toEqual({ count: 2, cost: 0.01 });
	});

	it("prices Meta Muse search grounding at $0.0025/query", () => {
		expect(computeWebSearchCost([search, search], "meta")).toEqual({ count: 2, cost: 0.005 });
	});

	it("defaults to $0.01/call for OpenAI and other providers", () => {
		expect(computeWebSearchCost([search], "openai")).toEqual({ count: 1, cost: 0.01 });
	});

	it("bills search queries only, excluding open_page browse actions", () => {
		// Mirrors an observed Muse turn: 2 searches + 3 open_page items.
		const output = [search, openPage, message, search, openPage, openPage];
		expect(computeWebSearchCost(output, "meta")).toEqual({ count: 2, cost: 0.005 });
	});

	it("counts web_search_call items that expose no action type (fallback)", () => {
		expect(computeWebSearchCost([noAction, noAction], "openai")).toEqual({ count: 2, cost: 0.02 });
	});

	it("returns zero when there are no web searches", () => {
		expect(computeWebSearchCost([message], "meta")).toEqual({ count: 0, cost: 0 });
		expect(computeWebSearchCost(undefined, "xai")).toEqual({ count: 0, cost: 0 });
	});
});
