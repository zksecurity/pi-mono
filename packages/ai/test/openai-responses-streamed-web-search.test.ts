import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function webSearchItem(id: string, actionType?: string): Record<string, unknown> {
	return {
		type: "web_search_call",
		id,
		status: "completed",
		...(actionType ? { action: { type: actionType } } : {}),
	};
}

function completedEvent(output: unknown[]): ResponseStreamEvent {
	return {
		type: "response.completed",
		sequence_number: 100,
		response: {
			id: "resp_ws",
			status: "completed",
			output,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				total_tokens: 15,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	} as unknown as ResponseStreamEvent;
}

function itemEvents(kind: "added" | "done", index: number, item: Record<string, unknown>): ResponseStreamEvent {
	return {
		type: `response.output_item.${kind}`,
		sequence_number: index,
		output_index: index,
		item,
	} as unknown as ResponseStreamEvent;
}

async function run(events: ResponseStreamEvent[]): Promise<AssistantMessage> {
	const model = createModel();
	const output = createOutput(model);
	const stream = new AssistantMessageEventStream();
	async function* gen(): AsyncIterable<ResponseStreamEvent> {
		yield* events;
	}
	await processResponsesStream(gen(), output, stream, model);
	return output;
}

describe("web search counting from streamed output items", () => {
	it("counts streamed web_search_call items when the terminal output is empty (Codex shape)", async () => {
		const output = await run([
			itemEvents("added", 0, webSearchItem("ws_1")),
			itemEvents("done", 0, webSearchItem("ws_1", "search")),
			itemEvents("added", 1, webSearchItem("ws_2")),
			itemEvents("done", 1, webSearchItem("ws_2", "search")),
			completedEvent([]),
		]);
		expect(output.usage.extras).toEqual({ webSearch: 2 });
		expect(output.usage.cost.extras).toEqual({ webSearch: 0.02 });
	});

	it("prefers the terminal output when it carries the items (api.openai.com shape)", async () => {
		const output = await run([
			itemEvents("added", 0, webSearchItem("ws_1")),
			itemEvents("done", 0, webSearchItem("ws_1", "search")),
			completedEvent([webSearchItem("ws_1", "search")]),
		]);
		expect(output.usage.extras).toEqual({ webSearch: 1 });
	});

	it("applies the same action filter to streamed items: open_page is not billed", async () => {
		const output = await run([
			itemEvents("added", 0, webSearchItem("ws_1")),
			itemEvents("done", 0, webSearchItem("ws_1", "open_page")),
			completedEvent([]),
		]);
		expect(output.usage.extras).toBeUndefined();
	});

	it("counts nothing when no web_search_call items streamed", async () => {
		const output = await run([completedEvent([])]);
		expect(output.usage.extras).toBeUndefined();
	});
});
