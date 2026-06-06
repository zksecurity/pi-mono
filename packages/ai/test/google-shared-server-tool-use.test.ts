import { FunctionCallingConfigMode } from "@google/genai";
import { describe, expect, it } from "vitest";
import { applyServerToolPart, buildGoogleToolConfig, convertMessages } from "../src/providers/google-shared.ts";
import type { AssistantMessage, Context, Model, ServerToolUse } from "../src/types.ts";

function makeGemini3Model(
	api: "google-generative-ai" | "google-vertex" = "google-generative-ai",
	provider = "google",
	id = "gemini-3.1-pro-preview",
): Model<"google-generative-ai" | "google-vertex"> {
	return {
		id,
		name: "Gemini 3.1 Pro Preview",
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeAssistantMessage(
	model: { api: string; provider: string; id: string },
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("google-shared buildGoogleToolConfig", () => {
	it("returns undefined when neither a built-in tool nor a tool choice is present", () => {
		expect(buildGoogleToolConfig({ hasFunctionTools: true, hasBuiltInTool: false })).toBeUndefined();
		expect(buildGoogleToolConfig({ hasFunctionTools: false, hasBuiltInTool: false })).toBeUndefined();
	});

	it("preserves prior behavior: maps an explicit toolChoice when no built-in tool is present", () => {
		expect(buildGoogleToolConfig({ hasFunctionTools: true, hasBuiltInTool: false, toolChoice: "any" })).toEqual({
			functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
		});
	});

	it("enables server-side tool circulation and forces VALIDATED mode when combining a built-in tool with functions", () => {
		const config = buildGoogleToolConfig({ hasFunctionTools: true, hasBuiltInTool: true });
		expect(config).toEqual({
			functionCallingConfig: { mode: FunctionCallingConfigMode.VALIDATED },
			includeServerSideToolInvocations: true,
		});
	});

	it("upgrades an explicit AUTO choice to VALIDATED when server-side circulation is on", () => {
		const config = buildGoogleToolConfig({ hasFunctionTools: true, hasBuiltInTool: true, toolChoice: "auto" });
		expect(config?.functionCallingConfig?.mode).toBe(FunctionCallingConfigMode.VALIDATED);
	});

	it("honors an explicit NONE choice even with server-side circulation", () => {
		const config = buildGoogleToolConfig({ hasFunctionTools: true, hasBuiltInTool: true, toolChoice: "none" });
		expect(config?.functionCallingConfig?.mode).toBe(FunctionCallingConfigMode.NONE);
		expect(config?.includeServerSideToolInvocations).toBe(true);
	});

	it("sets the flag without a function-calling mode when only a built-in tool is present", () => {
		const config = buildGoogleToolConfig({ hasFunctionTools: false, hasBuiltInTool: true });
		expect(config).toEqual({ includeServerSideToolInvocations: true });
	});
});

describe("google-shared applyServerToolPart", () => {
	it("pairs a toolCall and toolResponse into a single ServerToolUse block by id", () => {
		const content: AssistantMessage["content"] = [];
		expect(
			applyServerToolPart(content, {
				toolCall: { id: "s1", toolType: "GOOGLE_SEARCH_WEB" as any, args: { queries: ["pi"] } },
				thoughtSignature: "Y2FsbA==",
			}),
		).toBe(true);
		expect(
			applyServerToolPart(content, {
				toolResponse: { id: "s1", toolType: "GOOGLE_SEARCH_WEB" as any, response: { search_suggestions: "x" } },
				thoughtSignature: "cmVzcA==",
			}),
		).toBe(true);

		expect(content).toHaveLength(1);
		expect(content[0]).toEqual({
			type: "serverToolUse",
			id: "s1",
			toolType: "GOOGLE_SEARCH_WEB",
			args: { queries: ["pi"] },
			response: { search_suggestions: "x" },
			callSignature: "Y2FsbA==",
			responseSignature: "cmVzcA==",
		} satisfies ServerToolUse);
	});

	it("returns false for non server-side tool parts", () => {
		const content: AssistantMessage["content"] = [];
		expect(applyServerToolPart(content, { text: "hello" } as any)).toBe(false);
		expect(content).toHaveLength(0);
	});
});

describe("google-shared convertMessages — ServerToolUse round-trip", () => {
	const block: ServerToolUse = {
		type: "serverToolUse",
		id: "s1",
		toolType: "GOOGLE_SEARCH_WEB",
		args: { queries: ["pi"] },
		response: { search_suggestions: "x" },
		callSignature: "Y2FsbA==",
		responseSignature: "cmVzcA==",
	};

	it("replays toolCall + toolResponse parts with signatures for the same model", () => {
		const model = makeGemini3Model();
		const context: Context = { messages: [makeAssistantMessage(model, [block])] };
		const contents = convertMessages(model, context);
		const modelTurn = contents.find((c) => c.role === "model");
		const parts = modelTurn?.parts ?? [];

		const callPart = parts.find((p) => p.toolCall);
		const responsePart = parts.find((p) => p.toolResponse);
		expect(callPart?.toolCall).toMatchObject({ id: "s1", toolType: "GOOGLE_SEARCH_WEB", args: { queries: ["pi"] } });
		expect(callPart?.thoughtSignature).toBe("Y2FsbA==");
		expect(responsePart?.toolResponse).toMatchObject({ id: "s1", response: { search_suggestions: "x" } });
		expect(responsePart?.thoughtSignature).toBe("cmVzcA==");
	});

	it("drops server-side tool records when replaying to a different model", () => {
		const model = makeGemini3Model();
		const context: Context = {
			messages: [makeAssistantMessage({ ...model, id: "other-model" }, [block])],
		};
		const contents = convertMessages(model, context);
		// The assistant turn has no other content, so it is omitted entirely.
		expect(contents.find((c) => c.role === "model")).toBeUndefined();
	});
});
