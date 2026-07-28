import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, ServerToolUse } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

const searchResult = {
	type: "web_search_tool_result",
	tool_use_id: "srvtoolu_01",
	content: [
		{
			type: "web_search_result",
			title: "Example",
			url: "https://example.com",
			page_age: null,
			encrypted_content: "opaque-payload",
		},
	],
};

/**
 * The shape a native-web-search turn actually arrives in, captured from the live API:
 * the two thinking blocks are separated only by the server-side search pair.
 */
const searchTurnEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_search",
				usage: {
					input_tokens: 10,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "thinking", thinking: "" },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "signature_delta", signature: "sig-one" },
		}),
	},
	{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 1,
			content_block: {
				type: "server_tool_use",
				id: "srvtoolu_01",
				name: "web_search",
				input: {},
				caller: { type: "direct" },
			},
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: '{"query":"pi mono' },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: ' fork"}' },
		}),
	},
	{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
	{
		event: "content_block_start",
		data: JSON.stringify({ type: "content_block_start", index: 2, content_block: searchResult }),
	},
	{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 2 }) },
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 3,
			content_block: { type: "thinking", thinking: "" },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 3,
			delta: { type: "signature_delta", signature: "sig-two" },
		}),
	},
	{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 3 }) },
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
				server_tool_use: { web_search_requests: 1 },
			},
		}),
	},
	{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
];

const model = getModel("anthropic", "claude-opus-4-8");

async function captureSearchTurn(): Promise<AssistantMessage> {
	const context: Context = {
		messages: [{ role: "user", content: "search the web", timestamp: Date.now() }],
	};
	const result = await streamAnthropic(model, context, {
		nativeTools: { webSearch: true },
		client: createFakeAnthropicClient(createSseResponse(searchTurnEvents)),
	}).result();
	expect(result.stopReason).toBe("stop");
	return result;
}

class PayloadCaptured extends Error {}

async function capturePayloadFor(assistant: AssistantMessage): Promise<{ role: string; content: any[] }[]> {
	let captured: { messages: { role: string; content: any[] }[] } | undefined;
	const context: Context = {
		messages: [
			{ role: "user", content: "search the web", timestamp: Date.now() },
			assistant,
			{ role: "user", content: "now summarize", timestamp: Date.now() },
		],
	};
	await streamAnthropic(model, context, {
		apiKey: "fake-key",
		nativeTools: { webSearch: true },
		onPayload: (payload) => {
			captured = payload as { messages: { role: string; content: any[] }[] };
			throw new PayloadCaptured();
		},
	}).result();
	if (!captured) throw new Error("Expected payload capture before request");
	return captured.messages;
}

describe("Anthropic server-side tool blocks", () => {
	it("captures the server_tool_use / web_search_tool_result pair in message content", async () => {
		const result = await captureSearchTurn();

		expect(result.content.map((b) => b.type)).toEqual(["thinking", "serverToolUse", "thinking"]);
		const block = result.content[1] as ServerToolUse;
		expect(block.id).toBe("srvtoolu_01");
		expect(block.toolType).toBe("web_search");
		expect(block.args).toEqual({ query: "pi mono fork" });
		expect(block.caller).toEqual({ type: "direct" });
		expect(block.response).toEqual(searchResult);
		// The scratch buffer for streamed input must not survive into history.
		expect(block).not.toHaveProperty("partialJson");
	});

	it("echoes the pair back so the two thinking blocks never become adjacent", async () => {
		const messages = await capturePayloadFor(await captureSearchTurn());

		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant?.content.map((b) => b.type)).toEqual([
			"thinking",
			"server_tool_use",
			"web_search_tool_result",
			"thinking",
		]);
		expect(assistant?.content[1]).toEqual({
			type: "server_tool_use",
			id: "srvtoolu_01",
			name: "web_search",
			input: { query: "pi mono fork" },
			caller: { type: "direct" },
		});
		// Replayed verbatim: encrypted_content and page_age must survive untouched.
		expect(assistant?.content[2]).toEqual(searchResult);
	});

	it("drops blocks from other providers instead of forging Anthropic ones", async () => {
		const assistant = await captureSearchTurn();
		assistant.content[1] = {
			type: "serverToolUse",
			id: "g-1",
			toolType: "GOOGLE_SEARCH_WEB",
			args: { query: "x" },
			response: { results: [] },
		} satisfies ServerToolUse;

		const messages = await capturePayloadFor(assistant);
		const assistantParam = messages.find((m) => m.role === "assistant");
		expect(assistantParam?.content.map((b) => b.type)).toEqual(["thinking", "thinking"]);
	});

	it("drops the pair when web search is no longer enabled on the request", async () => {
		const assistant = await captureSearchTurn();
		let captured: { messages: { role: string; content: any[] }[] } | undefined;
		await streamAnthropic(
			model,
			{
				messages: [
					{ role: "user", content: "search the web", timestamp: Date.now() },
					assistant,
					{ role: "user", content: "now summarize", timestamp: Date.now() },
				],
			},
			{
				apiKey: "fake-key",
				onPayload: (payload) => {
					captured = payload as { messages: { role: string; content: any[] }[] };
					throw new PayloadCaptured();
				},
			},
		).result();

		const assistantParam = captured?.messages.find((m) => m.role === "assistant");
		expect(assistantParam?.content.map((b) => b.type)).toEqual(["thinking", "thinking"]);
	});

	it("drops a call whose result never arrived rather than sending a dangling tool use", async () => {
		const truncated = searchTurnEvents.filter((e) => !e.data.includes("web_search_tool_result"));
		const context: Context = {
			messages: [{ role: "user", content: "search the web", timestamp: Date.now() }],
		};
		const result = await streamAnthropic(model, context, {
			nativeTools: { webSearch: true },
			client: createFakeAnthropicClient(createSseResponse(truncated)),
		}).result();
		expect((result.content[1] as ServerToolUse).response).toBeUndefined();

		const messages = await capturePayloadFor(result);
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant?.content.map((b) => b.type)).toEqual(["thinking", "thinking"]);
	});
});
