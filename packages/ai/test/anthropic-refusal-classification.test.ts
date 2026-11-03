import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";
import { isRefusal } from "../src/utils/refusal.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * Guards the contract between the Anthropic adapter's stop-reason mapping and
 * refusal classification.
 *
 * Derive messages from wire fixtures so structured signals and readable error
 * details are both verified through the adapter.
 */

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		beta: {
			messages: {
				create: () => ({
					asResponse: async () => response,
				}),
			},
		},
	} as unknown as Anthropic;
}

function eventsWithStopReason(
	stopReason: string,
	stopDetails?: Record<string, unknown>,
): Array<{ event: string; data: string }> {
	return [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
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
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: stopReason, ...(stopDetails ? { stop_details: stopDetails } : {}) },
				usage: { input_tokens: 10, output_tokens: 0 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

async function runWithStopReason(stopReason: string, stopDetails?: Record<string, unknown>) {
	const model = getModel("anthropic", "claude-opus-4-8");
	const response = createSseResponse(eventsWithStopReason(stopReason, stopDetails));
	// The adapter throws on a terminal error stop reason; the stream still
	// resolves to the assistant message carrying it.
	return await streamAnthropic(model, normalizeContext(context), {
		client: createFakeAnthropicClient(response),
	}).result();
}

describe("Anthropic refusal classification", () => {
	it("classifies a sensitive-content stop as a refusal", async () => {
		const result = await runWithStopReason("sensitive");

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.refusal).toEqual({ source: "stop_reason", raw: "sensitive" });
		expect(isRefusal(result)).toBe(true);
	});

	it("classifies a classifier refusal with an explanation", async () => {
		const explanation =
			"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";
		const result = await runWithStopReason("refusal", { type: "refusal", category: "cyber", explanation });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(explanation);
		expect(result.refusal?.source).toBe("stop_reason");
		expect(JSON.parse(result.refusal!.raw)).toEqual({
			stop_reason: "refusal",
			stop_details: { type: "refusal", category: "cyber", explanation },
		});
		expect(isRefusal(result)).toBe(true);
	});

	it("classifies a refusal that carries no explanation", async () => {
		// stop_details.explanation is nullable, so the adapter's own fallback
		// wording has to stay classifiable too.
		const result = await runWithStopReason("refusal", { type: "refusal", category: null, explanation: null });

		expect(result.stopReason).toBe("error");
		expect(isRefusal(result)).toBe(true);
	});

	it("does not classify an ordinary completion as a refusal", async () => {
		const result = await runWithStopReason("end_turn");

		expect(result.stopReason).toBe("stop");
		expect(isRefusal(result)).toBe(false);
	});

	it("captures a refusal without stop_details", async () => {
		const result = await runWithStopReason("refusal");
		expect(result.refusal).toEqual({ source: "stop_reason", raw: "refusal" });
	});

	it("captures sensitive stop details", async () => {
		const details = { type: "refusal", category: "cyber", explanation: "Request blocked." };
		const result = await runWithStopReason("sensitive", details);
		expect(JSON.parse(result.refusal!.raw)).toEqual({ stop_reason: "sensitive", stop_details: details });
	});

	it("keeps an unknown stop reason as an ordinary error", async () => {
		const result = await runWithStopReason("future_reason");
		expect(result.stopReason).toBe("error");
		expect(result.rawStopReason).toBe("future_reason");
		expect(result.errorMessage).toBe("Provider stopped with: future_reason");
		expect(result.refusal).toBeUndefined();
	});
});
