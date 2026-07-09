import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const anthropicModel = {
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 1024,
} as unknown as Model<"anthropic-messages">;

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sseResponse(events: object[]): Response {
	const body = events.map((e) => `data: ${JSON.stringify(e)}\n`).join("");
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Capture the JSON body POSTed to the proxy, replying with a minimal done stream. */
function stubProxyFetch(): () => Record<string, any> | undefined {
	let captured: Record<string, any> | undefined;
	const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
		captured = JSON.parse(init.body as string);
		return sseResponse([{ type: "start" }, { type: "done", reason: "stop", usage }]);
	});
	vi.stubGlobal("fetch", fetchMock);
	return () => captured;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy", () => {
	it("preserves tool-call metadata received only on toolcall_end", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test|fc_test", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"hello"}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "call_test|fc_test",
					name: "lookup",
					arguments: { value: "hello" },
					namespace: "dynamic_tools",
				},
			},
			{ type: "done", reason: "toolUse", usage },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const endEvent = events.find((event) => event.type === "toolcall_end");

		expect(endEvent).toMatchObject({
			type: "toolcall_end",
			toolCall: { namespace: "dynamic_tools" },
		});
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { value: "hello" },
			namespace: "dynamic_tools",
		});
	});

	// Regression tests for https://github.com/earendil-works/pi/issues/8996
	it("processes terminal metadata when the event is not newline-terminated", async () => {
		const start = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		const done = `data: ${JSON.stringify({ type: "done", reason: "stop", usage, providerThinkingLevel: "high" })}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(start + done, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.providerThinkingLevel).toBe("high");
	});

	it("emits an error instead of hanging when the stream ends without a terminal event", async () => {
		const body = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connection closed by proxy server");
	});
});

describe("streamProxy request serialization", () => {
	it("relays nativeTools to the proxy request body", async () => {
		const getCaptured = stubProxyFetch();

		const stream = streamProxy(anthropicModel, context, {
			authToken: "token",
			proxyUrl: "https://proxy.test",
			temperature: 0.5,
			nativeTools: { webSearch: { allowedDomains: ["example.com"] } },
		});
		await stream.result();

		const body = getCaptured();
		expect(body?.options.nativeTools).toEqual({ webSearch: { allowedDomains: ["example.com"] } });
		// Regression guard: a plain serializable option still flows too.
		expect(body?.options.temperature).toBe(0.5);
	});

	it("strips non-serializable and proxy-only keys from the request body", async () => {
		const getCaptured = stubProxyFetch();

		const stream = streamProxy(anthropicModel, context, {
			authToken: "token",
			proxyUrl: "https://proxy.test",
			apiKey: "secret-key",
			env: { AWS_REGION: "us-east-1" },
			onPayload: () => undefined,
			onResponse: () => undefined,
			signal: new AbortController().signal,
			nativeTools: { webSearch: true },
		});
		await stream.result();

		const options = getCaptured()?.options ?? {};
		for (const key of ["authToken", "proxyUrl", "apiKey", "env", "onPayload", "onResponse", "signal"]) {
			expect(options).not.toHaveProperty(key);
		}
		expect(options.nativeTools).toEqual({ webSearch: true });
	});
});
