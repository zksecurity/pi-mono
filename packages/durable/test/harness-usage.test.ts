// Native-search extras and wrapped model fallback usage stay complete in conversation and session totals.
import { fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { addUsage } from "../src/harness/usage.ts";
import { chatSetup } from "./chat-support.ts";
import { context } from "./session-support.ts";

function usage(searches: number): Usage {
	return {
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
		extras: { webSearch: searches },
		cost: {
			input: 0.1,
			output: 0.2,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.3 + searches * 0.01,
			extras: { webSearch: searches * 0.01 },
		},
	};
}

describe("durable usage extras", () => {
	it("sums counters and cost breakdowns without adding search costs twice", () => {
		const total = usage(2);
		addUsage(total, usage(3));
		expect(total.extras).toEqual({ webSearch: 5 });
		expect(total.cost.extras).toEqual({ webSearch: 0.05 });
		expect(total.cost.total).toBeCloseTo(0.65);
	});

	it("treats prototype names as ordinary extra counters", () => {
		const total = usage(0);
		const next = usage(0);
		next.extras = JSON.parse('{"__proto__":2,"toString":3}');
		next.cost.extras = JSON.parse('{"__proto__":0.02,"toString":0.03}');
		addUsage(total, next);
		addUsage(total, next);
		expect(total.extras).toEqual({ webSearch: 0, ...JSON.parse('{"__proto__":4,"toString":6}') });
		expect(Object.getPrototypeOf(total.extras)).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(total.cost.extras, "__proto__")?.value).toBe(0.04);
	});

	it("counts wrapped declined attempts per model across turns and conversations", async () => {
		const state = chatSetup();
		state.faux.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
		]);
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: state.models,
				registry: state.registry,
				modelRequests: {
					recover: async () => undefined,
					execute: async (_request, run) => {
						const message = await run();
						message.usage = usage(2);
						const declined = usage(1);
						message.diagnostics = [
							{
								type: "model_fallback",
								timestamp: 1,
								details: {
									provider: "faux",
									model: "declined",
									attempt: 1,
									usage: { ...declined, cost: { ...declined.cost } },
								},
							},
						];
						return message;
					},
				},
			},
			context,
		);
		try {
			const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			for (const content of ["one", "two"]) {
				await (await root.submit({ type: "input", content }, context)).wait(context);
				await root.waitForIdle(context);
			}
			const other = await harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
				context,
			);
			await (await other.submit({ type: "input", content: "three" }, context)).wait(context);
			const totals = await harness.usage(context);
			expect(totals.models["faux/faux-1"]?.extras).toEqual({ webSearch: 6 });
			expect(totals.models["faux/faux-1"]?.cost.extras).toEqual({ webSearch: 0.06 });
			expect(totals.models["faux/declined"]?.extras).toEqual({ webSearch: 3 });
			expect(totals.models["faux/declined"]?.cost.total).toBeCloseTo(0.93);
		} finally {
			await harness.close(context);
		}
	});
});
