import type { Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.ts";

const model = {
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

const EMPTY_USAGE = {
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
		return sseResponse([{ type: "start" }, { type: "done", reason: "stop", usage: EMPTY_USAGE }]);
	});
	vi.stubGlobal("fetch", fetchMock);
	return () => captured;
}

describe("streamProxy request serialization", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("relays nativeTools to the proxy request body", async () => {
		const getCaptured = stubProxyFetch();

		const stream = streamProxy(model, context, {
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

		const stream = streamProxy(model, context, {
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
