import { describe, expect, it } from "vitest";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { Api, AssistantMessageEvent, Model, StreamOptions } from "../src/types.ts";
import { classifyRefusal } from "../src/utils/refusal.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 0 }] });
const token = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }))}.test`;

function model<T extends Api>(api: T, provider: string): Model<T> {
	return {
		api,
		provider,
		id: "test-model",
		name: "Test model",
		baseUrl: "https://provider.invalid/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 10000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const adapters = [
	{
		name: "OpenAI Responses",
		run: (options: StreamOptions) => streamResponses(model("openai-responses", "openai"), context, options),
	},
	{
		name: "Codex",
		run: (options: StreamOptions) => streamCodex(model("openai-codex-responses", "openai-codex"), context, options),
	},
	{
		name: "Azure Responses",
		run: (options: StreamOptions) =>
			streamAzure(model("azure-openai-responses", "azure"), context, {
				...options,
				azureApiVersion: "2025-04-01-preview",
			}),
	},
	{
		name: "xAI Responses",
		run: (options: StreamOptions) => streamResponses(model("openai-responses", "xai"), context, options),
	},
];

function sse(events: Record<string, unknown>[]): Response {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

for (const adapter of adapters) {
	describe(adapter.name, () => {
		async function run(events: Record<string, unknown>[]) {
			const stream = adapter.run({ apiKey: token, transport: "sse", maxRetries: 0, fetch: async () => sse(events) });
			const emitted: AssistantMessageEvent[] = [];
			for await (const event of stream) emitted.push(event);
			const result = await stream.result();
			expect(emitted.at(-1)?.type).toBe(result.stopReason === "error" ? "error" : "done");
			return result;
		}

		it.each([
			"content_filter",
			"content_policy_violation",
			"image_content_policy_violation",
			"cyber_policy",
			"bio_policy",
			"misalignment_policy_violation",
		])("captures %s from HTTP and streamed errors", async (code) => {
			const error = { code, message: "Request blocked." };
			for (const event of [
				{ type: "error", ...error },
				{ type: "response.failed", response: { status: "failed", error } },
			]) {
				const result = await run([event]);
				expect(result.stopReason).toBe("error");
				expect(result.refusal).toEqual({ source: "error_code", raw: code });
				expect(classifyRefusal(result)).toEqual({ kind: "refusal", source: "error_code" });
			}
			const result = await adapter
				.run({
					apiKey: token,
					transport: "sse",
					maxRetries: 0,
					fetch: async () => Response.json({ error }, { status: 400 }),
				})
				.result();
			expect(result.stopReason).toBe("error");
			expect(result.refusal).toEqual({ source: "error_code", raw: code });
		});

		it("captures incomplete content_filter", async () => {
			const result = await run([
				{
					type: "response.incomplete",
					response: {
						status: "incomplete",
						incomplete_details: { reason: "content_filter" },
					},
				},
			]);
			expect(result.stopReason).toBe("error");
			expect(result.rawStopReason).toBe("incomplete.content_filter");
			expect(result.refusal).toEqual({ source: "stop_reason", raw: "content_filter" });
		});

		it("captures native refusal deltas and completed refusal parts", async () => {
			const refusal = "Request declined.";
			const item = { type: "message", id: "msg-1", role: "assistant", content: [{ type: "refusal", refusal }] };
			const result = await run([
				{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
				{ type: "response.refusal.delta", output_index: 0, delta: "Request " },
				{ type: "response.refusal.delta", output_index: 0, delta: "declined." },
				{ type: "response.refusal.done", output_index: 0, refusal },
				{ type: "response.output_item.done", output_index: 0, item },
				{ type: "response.completed", response: { status: "completed", output: [item] } },
			]);
			expect(result.stopReason).toBe("stop");
			expect(result.refusal).toEqual({ source: "content_filter", raw: refusal });
			expect(result.content).toMatchObject([{ type: "text", text: refusal }]);
			expect(classifyRefusal(result)).toEqual({ kind: "refusal", source: "content_filter" });
		});

		it.each(["delta", "done", "output_item", "terminal"])("captures a refusal provided only by %s", async (stage) => {
			const refusal = "Declined.";
			const item = { type: "message", id: "msg-1", content: [{ type: "refusal", refusal }] };
			const events: Record<string, unknown>[] = [];
			if (stage === "delta") events.push({ type: "response.refusal.delta", output_index: 0, delta: refusal });
			if (stage === "done") events.push({ type: "response.refusal.done", output_index: 0, refusal });
			if (stage === "output_item") events.push({ type: "response.output_item.done", output_index: 0, item });
			events.push({
				type: "response.completed",
				response: { status: "completed", output: stage === "terminal" ? [item] : [] },
			});
			const result = await run(events);
			expect(result.refusal).toEqual({ source: "content_filter", raw: refusal });
		});

		it.each([true, false])("classifies content_filters only when blocked=%s", async (blocked) => {
			const filters = [
				{
					blocked,
					source_type: "completion",
					content_filter_results: { violence: { filtered: blocked, severity: "high" } },
				},
			];
			const result = await run([
				{ type: "response.completed", response: { status: "completed", content_filters: filters } },
			]);
			expect(result.refusal).toEqual(
				blocked ? { source: "content_filter", raw: JSON.stringify(filters) } : undefined,
			);
		});

		it.each(["server_error", "invalid_prompt", "rate_limit_exceeded"])(
			"does not classify generic %s errors",
			async (code) => {
				const result = await run([
					{ type: "response.failed", response: { status: "failed", error: { code, message: "Other failure" } } },
				]);
				expect(result.stopReason).toBe("error");
				expect(result.refusal).toBeUndefined();
				expect(classifyRefusal(result)).toBeUndefined();
			},
		);

		it("gives account restrictions priority over a native policy signal", async () => {
			const result = await run([
				{
					type: "response.failed",
					response: {
						status: "failed",
						error: {
							code: "cyber_policy",
							message:
								"Access to this model has been temporarily limited for suspicious activity related to cybersecurity.",
						},
					},
				},
			]);
			expect(classifyRefusal(result)).toEqual({ kind: "accountRestriction", source: "pattern" });
		});

		it("keeps unknown statuses as ordinary errors", async () => {
			const result = await run([{ type: "response.completed", response: { status: "future_status" } }]);
			expect(result.stopReason).toBe("error");
			expect(result.rawStopReason).toBe("future_status");
			expect(result.errorMessage).toBe("Provider stopped with: future_status");
			expect(result.refusal).toBeUndefined();
		});
	});
}
