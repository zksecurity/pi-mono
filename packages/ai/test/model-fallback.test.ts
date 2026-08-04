import { describe, expect, it } from "vitest";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	ProviderId,
	StopReason,
	Usage,
} from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import {
	getDeclinedAttempts,
	getDowngradeChainIds,
	MODEL_DOWNGRADE_CHAINS,
	resolveDowngradeChain,
	streamWithModelFallback,
	streamWithModelFallbackEvents,
	sumUsage,
} from "../src/utils/fallback.ts";

const ANTHROPIC_REFUSAL =
	"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";
const OPENAI_ACCOUNT_LIMIT =
	"This user's access to gpt-5.2-codex has been temporarily limited for potentially suspicious activity related to cybersecurity.";

function createModel(provider: ProviderId, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	};
}

function createResponse(model: Model<Api>, stopReason: StopReason, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("downgrade chains", () => {
	it("walks the Anthropic opus chain strongest-first", () => {
		expect(getDowngradeChainIds("anthropic", "claude-opus-5")).toEqual([
			"claude-opus-4-8",
			"claude-opus-4-7",
			"claude-opus-4-6",
			"claude-opus-4-5",
		]);
	});

	it("picks up a model from the middle of a chain", () => {
		expect(getDowngradeChainIds("anthropic", "claude-opus-4-8")).toEqual([
			"claude-opus-4-7",
			"claude-opus-4-6",
			"claude-opus-4-5",
		]);
	});

	it("returns an empty chain for a model with nothing below it", () => {
		expect(getDowngradeChainIds("anthropic", "claude-opus-4-5")).toEqual([]);
		expect(getDowngradeChainIds("anthropic", "not-a-model")).toEqual([]);
		expect(getDowngradeChainIds("not-a-provider", "claude-opus-5")).toEqual([]);
	});

	it("does not let callers mutate the shared chain table", () => {
		getDowngradeChainIds("anthropic", "claude-opus-5").push("injected");
		expect(MODEL_DOWNGRADE_CHAINS.anthropic.flat()).not.toContain("injected");
	});

	it("never repeats a model within one chain", () => {
		for (const [provider, chains] of Object.entries(MODEL_DOWNGRADE_CHAINS)) {
			for (const chain of chains) {
				expect(new Set(chain).size, `${provider}: ${chain.join(" -> ")} repeats an entry`).toBe(chain.length);
			}
		}
	});

	it("keeps repeated tails consistent so first-match lookup is unambiguous", () => {
		// A model may head one chain and appear in the tail of another (the three
		// gpt-5.6 variants share a tail). getDowngradeChainIds takes the first
		// chain containing the model, so every chain must agree on its successors.
		for (const [provider, chains] of Object.entries(MODEL_DOWNGRADE_CHAINS)) {
			const suffixes = new Map<string, string>();
			for (const chain of chains) {
				chain.forEach((id, index) => {
					const suffix = chain.slice(index + 1).join(" -> ");
					const seen = suffixes.get(id);
					if (seen === undefined) suffixes.set(id, suffix);
					else expect(suffix, `${provider}/${id} has conflicting successors`).toBe(seen);
				});
			}
		}
	});

	it("resolves to models, dropping ids the registry does not serve", () => {
		const model = createModel("anthropic", "claude-opus-5");
		// A registry that only exposes 4-8 and 4-5 — 4-7 and 4-6 are unavailable.
		const available = new Set(["claude-opus-4-8", "claude-opus-4-5"]);
		const chain = resolveDowngradeChain(model, (provider, id) =>
			available.has(id) ? createModel(provider, id) : undefined,
		);
		expect(chain.map((m) => m.id)).toEqual(["claude-opus-5", "claude-opus-4-8", "claude-opus-4-5"]);
	});
});

describe("sumUsage", () => {
	function usage(input: number, costInput: number, extras?: Record<string, number>): Usage {
		return {
			input,
			output: 1,
			cacheRead: 2,
			cacheWrite: 3,
			totalTokens: input + 6,
			extras,
			cost: { input: costInput, output: 0, cacheRead: 0, cacheWrite: 0, total: costInput },
		};
	}

	it("adds token counts and costs across attempts", () => {
		const total = sumUsage(usage(10, 0.5), usage(20, 1.5));
		expect(total.input).toBe(30);
		expect(total.output).toBe(2);
		expect(total.cacheRead).toBe(4);
		expect(total.cacheWrite).toBe(6);
		expect(total.totalTokens).toBe(42);
		expect(total.cost.input).toBeCloseTo(2);
		expect(total.cost.total).toBeCloseTo(2);
	});

	it("merges extras and leaves optional fields undefined when nobody reports them", () => {
		const total = sumUsage(usage(10, 0, { webSearch: 2 }), usage(10, 0, { webSearch: 3 }), usage(10, 0));
		expect(total.extras).toEqual({ webSearch: 5 });
		// No provider in the chain broke these out, so a 0 would be misleading.
		expect(total.reasoning).toBeUndefined();
		expect(total.cacheWrite1h).toBeUndefined();
	});

	it("sums optional fields only from the attempts that report them", () => {
		const withReasoning: Usage = { ...usage(10, 0), reasoning: 7 };
		const total = sumUsage(withReasoning, usage(10, 0));
		expect(total.reasoning).toBe(7);
	});

	it("returns a zeroed usage for no inputs", () => {
		expect(sumUsage().totalTokens).toBe(0);
	});
});

describe("streamWithModelFallback", () => {
	const chain = [
		createModel("anthropic", "claude-opus-5"),
		createModel("anthropic", "claude-opus-4-8"),
		createModel("anthropic", "claude-opus-4-7"),
	];

	it("returns the first success without touching later models", async () => {
		const tried: string[] = [];
		const result = await streamWithModelFallback(
			async (model) => {
				tried.push(model.id);
				return createResponse(model, "stop");
			},
			{ models: chain },
		);

		expect(tried).toEqual(["claude-opus-5"]);
		expect(result.stopReason).toBe("stop");
		expect(result.responseModel).toBeUndefined();
		expect(result.diagnostics).toBeUndefined();
	});

	it("walks the chain on refusals and reports the serving model", async () => {
		const tried: string[] = [];
		const result = await streamWithModelFallback(
			async (model) => {
				tried.push(model.id);
				return model.id === "claude-opus-4-7"
					? createResponse(model, "stop")
					: createResponse(model, "error", ANTHROPIC_REFUSAL);
			},
			{ models: chain },
		);

		expect(tried).toEqual(["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7"]);
		expect(result.stopReason).toBe("stop");
		expect(result.responseModel).toBe("claude-opus-4-7");
		expect(result.diagnostics?.map((d) => d.details?.model)).toEqual(["claude-opus-5", "claude-opus-4-8"]);
		expect(result.diagnostics?.[0].error?.message).toBe(ANTHROPIC_REFUSAL);
		// Declined usage is kept per-hop, not summed into the serving model's.
		expect(result.usage.input).toBe(10);
		expect(result.diagnostics?.[0].details?.usage).toMatchObject({ input: 10 });
	});

	it("returns the last refusal when every model in the chain declines", async () => {
		const tried: string[] = [];
		const result = await streamWithModelFallback(
			async (model) => {
				tried.push(model.id);
				return createResponse(model, "error", ANTHROPIC_REFUSAL);
			},
			{ models: chain },
		);

		expect(tried).toEqual(["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7"]);
		expect(result.stopReason).toBe("error");
		expect(result.responseModel).toBe("claude-opus-4-7");
		expect(result.diagnostics).toHaveLength(2);
	});

	it("does not walk the chain for an account-scoped restriction", async () => {
		const tried: string[] = [];
		const result = await streamWithModelFallback(
			async (model) => {
				tried.push(model.id);
				return createResponse(model, "error", OPENAI_ACCOUNT_LIMIT);
			},
			{ models: chain },
		);

		// Same credential across the whole chain — downgrading cannot help.
		expect(tried).toEqual(["claude-opus-5"]);
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics).toBeUndefined();
	});

	it("fails fast on an ordinary error instead of downgrading", async () => {
		const tried: string[] = [];
		const result = await streamWithModelFallback(
			async (model) => {
				tried.push(model.id);
				return createResponse(model, "error", "prompt is too long: 213462 tokens > 200000 maximum");
			},
			{ models: chain },
		);

		expect(tried).toEqual(["claude-opus-5"]);
		expect(result.stopReason).toBe("error");
	});

	it("treats aborts as terminal", async () => {
		const tried: string[] = [];
		const result = await streamWithModelFallback(
			async (model) => {
				tried.push(model.id);
				return createResponse(model, "aborted");
			},
			{ models: chain },
		);

		expect(tried).toEqual(["claude-opus-5"]);
		expect(result.stopReason).toBe("aborted");
	});

	it("retries transient errors per-model before downgrading", async () => {
		const tried: string[] = [];
		const result = await streamWithModelFallback(
			async (model) => {
				tried.push(model.id);
				// Opus 5 is transiently overloaded once, then refuses outright.
				if (model.id === "claude-opus-5") {
					const attemptsSoFar = tried.filter((id) => id === "claude-opus-5").length;
					return attemptsSoFar === 1
						? createResponse(model, "error", "529 overloaded_error: Overloaded")
						: createResponse(model, "error", ANTHROPIC_REFUSAL);
				}
				return createResponse(model, "stop");
			},
			{ models: chain, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		);

		// Transient retry runs inside the model; the refusal moves to the next one
		// rather than being retried again on the model that just refused.
		expect(tried).toEqual(["claude-opus-5", "claude-opus-5", "claude-opus-4-8"]);
		expect(result.stopReason).toBe("stop");
		expect(result.responseModel).toBe("claude-opus-4-8");
	});

	it("emits fallback callbacks for each hop", async () => {
		const hops: string[] = [];
		let finished: { success: boolean; model?: string; declined: number } | undefined;

		await streamWithModelFallback(
			async (model) =>
				model.id === "claude-opus-4-8"
					? createResponse(model, "stop")
					: createResponse(model, "error", ANTHROPIC_REFUSAL),
			{
				models: chain,
				fallbackCallbacks: {
					onFallback: (from, to, attempt) => {
						hops.push(`${attempt}:${from.id}->${to.id}`);
					},
					onFallbackFinished: (success, servingModel, declined) => {
						finished = { success, model: servingModel?.id, declined };
					},
				},
			},
		);

		expect(hops).toEqual(["1:claude-opus-5->claude-opus-4-8"]);
		expect(finished).toEqual({ success: true, model: "claude-opus-4-8", declined: 1 });
	});

	it("exposes declined-hop usage for budget accounting", async () => {
		const result = await streamWithModelFallback(
			async (model) =>
				model.id === "claude-opus-4-7"
					? createResponse(model, "stop")
					: createResponse(model, "error", ANTHROPIC_REFUSAL),
			{ models: chain },
		);

		const declined = getDeclinedAttempts(result);
		expect(declined.map((a) => ({ attempt: a.attempt, model: a.model }))).toEqual([
			{ attempt: 1, model: "claude-opus-5" },
			{ attempt: 2, model: "claude-opus-4-8" },
		]);
		expect(declined[0].provider).toBe("anthropic");
		expect(declined[0].errorMessage).toBe(ANTHROPIC_REFUSAL);

		// Serving usage alone under-reports the chain; the accessor closes the gap.
		expect(result.usage.input).toBe(10);
		const chainTotal = sumUsage(result.usage, ...declined.map((a) => a.usage));
		expect(chainTotal.input).toBe(30);
		expect(chainTotal.totalTokens).toBe(30);
	});

	it("returns no declined attempts when nothing declined", async () => {
		const result = await streamWithModelFallback(async (model) => createResponse(model, "stop"), { models: chain });
		expect(getDeclinedAttempts(result)).toEqual([]);
	});

	it("ignores diagnostics written by other subsystems", async () => {
		const result = await streamWithModelFallback(
			async (model) => {
				const response = createResponse(model, "stop");
				response.diagnostics = [{ type: "some_other_subsystem", timestamp: Date.now(), details: { usage: {} } }];
				return response;
			},
			{ models: chain },
		);
		expect(getDeclinedAttempts(result)).toEqual([]);
	});

	it("rejects an empty chain", async () => {
		await expect(
			streamWithModelFallback(async (model) => createResponse(model, "stop"), { models: [] }),
		).rejects.toThrow(/at least one model/);
	});

	it("preserves each declined attempt's own cost, priced by its own adapter", async () => {
		const result = await streamWithModelFallback(
			async (model) => {
				const response =
					model.id === "claude-opus-4-7"
						? createResponse(model, "stop")
						: createResponse(model, "error", ANTHROPIC_REFUSAL);
				// Distinct per-model rates: a ledger must see each hop's own number.
				response.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: model.id.length / 100 };
				return response;
			},
			{ models: chain },
		);

		const declined = getDeclinedAttempts(result);
		expect(declined.map((a) => a.usage.cost.total)).toEqual([
			"claude-opus-5".length / 100,
			"claude-opus-4-8".length / 100,
		]);
		const chainCost = sumUsage(result.usage, ...declined.map((a) => a.usage)).cost.total;
		expect(chainCost).toBeCloseTo(
			("claude-opus-5".length + "claude-opus-4-8".length + "claude-opus-4-7".length) / 100,
		);
	});

	it("gives a declined attempt a zeroed cost rather than undefined when a provider omits it", async () => {
		const result = await streamWithModelFallback(
			async (model) => {
				const response =
					model.id === "claude-opus-4-8"
						? createResponse(model, "stop")
						: createResponse(model, "error", ANTHROPIC_REFUSAL);
				if (model.id === "claude-opus-5") {
					(response.usage as { cost?: unknown }).cost = undefined;
				}
				return response;
			},
			{ models: chain },
		);

		// A ledger reading usage.cost.total must not throw on a malformed hop.
		expect(getDeclinedAttempts(result)[0].usage.cost.total).toBe(0);
	});
});

describe("streamWithModelFallbackEvents", () => {
	const chain = [
		createModel("anthropic", "claude-opus-5"),
		createModel("anthropic", "claude-opus-4-8"),
		createModel("anthropic", "claude-opus-4-7"),
	];

	/**
	 * An adapter-shaped stream: start, some text, then a terminal event.
	 *
	 * `stopReason` is narrowed to the reasons that can actually terminate a
	 * stream — "pending" is the in-flight state and never appears on a terminal
	 * event, so tests that need it push `end()` directly instead.
	 */
	function fakeStream(
		model: Model<Api>,
		stopReason: Exclude<StopReason, "pending">,
		errorMessage?: string,
		text?: string,
	) {
		const stream = new AssistantMessageEventStream();
		const message = createResponse(model, stopReason, errorMessage);
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			if (text !== undefined) {
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
			}
			stream.push(
				stopReason === "error" || stopReason === "aborted"
					? { type: "error", reason: stopReason, error: message }
					: { type: "done", reason: stopReason, message },
			);
		});
		return stream;
	}

	async function drain(stream: AssistantMessageEventStream) {
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		return { events, final: await stream.result() };
	}

	it("forwards exactly one start across the whole chain", async () => {
		// agent-loop appends a message to the conversation on every `start`; a
		// second one would duplicate the assistant turn.
		const { events, final } = await drain(
			streamWithModelFallbackEvents(
				(model) =>
					model.id === "claude-opus-4-7"
						? fakeStream(model, "stop", undefined, "answer")
						: fakeStream(model, "error", ANTHROPIC_REFUSAL),
				{ models: chain },
			),
		);

		expect(events.filter((e) => e.type === "start")).toHaveLength(1);
		expect(final.stopReason).toBe("stop");
		expect(final.responseModel).toBe("claude-opus-4-7");
	});

	it("swallows a discarded attempt's terminal event", async () => {
		// EventStream latches on the first terminal event, so forwarding a refused
		// attempt's would freeze the result on the refusal.
		const { events, final } = await drain(
			streamWithModelFallbackEvents(
				(model) =>
					model.id === "claude-opus-4-7"
						? fakeStream(model, "stop", undefined, "answer")
						: fakeStream(model, "error", ANTHROPIC_REFUSAL),
				{ models: chain },
			),
		);

		const terminals = events.filter((e) => e.type === "done" || e.type === "error");
		expect(terminals).toHaveLength(1);
		expect(terminals[0].type).toBe("done");
		expect(final.errorMessage).toBeUndefined();
	});

	it("emits events during the chain rather than only at the end", async () => {
		// The liveness property: a watchdog must see traffic before the chain settles.
		const stream = streamWithModelFallbackEvents(
			(model) =>
				model.id === "claude-opus-4-7"
					? fakeStream(model, "stop", undefined, "answer")
					: fakeStream(model, "error", ANTHROPIC_REFUSAL, "partial from a doomed attempt"),
			{ models: chain },
		);

		const iterator = stream[Symbol.asyncIterator]();
		const first = await iterator.next();
		expect(first.done).toBe(false);
		expect(first.value.type).toBe("start");

		const { events } = await drain(stream);
		// Text from discarded attempts is forwarded live — documented and accepted.
		const deltas = events.filter((e) => e.type === "text_delta");
		expect(deltas.length).toBeGreaterThan(0);
	});

	it("forwards a terminal error when every model declines", async () => {
		const { events, final } = await drain(
			streamWithModelFallbackEvents((model) => fakeStream(model, "error", ANTHROPIC_REFUSAL), { models: chain }),
		);

		const terminals = events.filter((e) => e.type === "done" || e.type === "error");
		expect(terminals).toHaveLength(1);
		expect(terminals[0].type).toBe("error");
		expect(final.stopReason).toBe("error");
		expect(getDeclinedAttempts(final)).toHaveLength(2);
	});

	it("does not walk the chain for an account restriction", async () => {
		const tried: string[] = [];
		const { final } = await drain(
			streamWithModelFallbackEvents(
				(model) => {
					tried.push(model.id);
					return fakeStream(model, "error", OPENAI_ACCOUNT_LIMIT);
				},
				{ models: chain },
			),
		);

		expect(tried).toEqual(["claude-opus-5"]);
		expect(final.stopReason).toBe("error");
	});

	it("forwards a start from a later attempt when the first emits none", async () => {
		// A Codex block throws before any event, so attempt 1 may produce nothing.
		const { events, final } = await drain(
			streamWithModelFallbackEvents(
				(model) => {
					if (model.id === "claude-opus-5") throw new Error(ANTHROPIC_REFUSAL);
					return fakeStream(model, "stop", undefined, "answer");
				},
				{ models: chain },
			),
		);

		expect(events.filter((e) => e.type === "start")).toHaveLength(1);
		expect(final.stopReason).toBe("stop");
		expect(final.responseModel).toBe("claude-opus-4-8");
	});

	it("reports an attempt that never reached a terminal stop reason as an error", async () => {
		// "pending" is the in-flight state for partial messages; a final message
		// carrying it means the stream ended without terminating properly.
		const { final } = await drain(
			streamWithModelFallbackEvents(
				(model) => {
					const stream = new AssistantMessageEventStream();
					const message = createResponse(model, "pending");
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						stream.end(message);
					});
					return stream;
				},
				{ models: chain },
			),
		);

		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/without a terminal stop reason/);
	});

	it("reports an empty chain through the stream instead of throwing", async () => {
		const { final } = await drain(
			streamWithModelFallbackEvents((model) => fakeStream(model, "stop"), { models: [] }),
		);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/at least one model/);
	});
});
