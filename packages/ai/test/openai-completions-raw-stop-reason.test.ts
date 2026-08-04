import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

describe("OpenAI completions raw stop reasons", () => {
	it("preserves refusal text sent through the native refusal delta", async () => {
		mockState.chunks = [
			{ choices: [{ index: 0, delta: { refusal: "Request " }, finish_reason: null }] },
			{ choices: [{ index: 0, delta: { refusal: "declined." }, finish_reason: "stop" }] },
		];
		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "Request declined." }]);
		expect(message.refusal).toEqual({ source: "content_filter", raw: "Request declined." });
	});
	it.each(["openai", "xai", "deepseek"])("preserves %s content_filter refusals", async (provider) => {
		mockState.chunks = [{ choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }];
		const message = await streamOpenAICompletions({ ...model, provider }, context, { apiKey: "test" }).result();
		expect(message.stopReason).toBe("error");
		expect(message.refusal).toEqual({ source: "stop_reason", raw: "content_filter" });
	});

	it("keeps unknown finish reasons as ordinary errors", async () => {
		mockState.chunks = [{ choices: [{ index: 0, delta: {}, finish_reason: "future_reason" }] }];
		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();
		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("future_reason");
		expect(message.errorMessage).toBe("Provider finish_reason: future_reason");
		expect(message.refusal).toBeUndefined();
	});
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("preserves raw finish reasons for successful stops", async () => {
		mockState.chunks = [{ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.rawStopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
	});

	it("preserves raw finish reasons for provider error stops", async () => {
		mockState.chunks = [{ id: "chatcmpl-2", choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("content_filter");
		expect(message.errorMessage).toBe("Provider finish_reason: content_filter");
	});
});
