// Model fallback commits, replay, retry budgets, and summarization without provider network calls.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, type ModelRequestIdentity } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat, textOf, unanswered } from "./chat-support.ts";
import { context } from "./session-support.ts";

const opened = new Set<Harness>();
const directories = new Set<string>();
const primary = { provider: "faux", modelId: "faux-1" };
const alternative = { provider: "faux", modelId: "fallback-1" };

afterEach(async () => {
	for (const harness of opened) await harness.close(context);
	opened.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

function setup() {
	return chatSetup({ models: [{ id: primary.modelId }, { id: alternative.modelId }] });
}

function refusal(kind: "text" | "native"): AssistantMessage {
	if (kind === "text") return fauxAssistantMessage("I can't help with that.");
	return {
		...fauxAssistantMessage([], { stopReason: "error", errorMessage: "Provider declined" }),
		refusal: { source: "content_filter", raw: "blocked" },
	};
}

describe("durable model fallback", () => {
	it.each(["text", "native"] as const)("retains a %s refusal and omits it from the next request", async (kind) => {
		const state = setup();
		state.faux.setResponses([
			refusal(kind),
			(request, _options, _state, model) => {
				expect(model.id).toBe(alternative.modelId);
				expect(request.messages.some((message) => message.role === "assistant")).toBe(false);
				return fauxAssistantMessage("42");
			},
			(_request, _options, _state, model) => {
				expect(model.id).toBe(primary.modelId);
				return fauxAssistantMessage("next turn");
			},
		]);
		const { harness, root } = await openChat(new MemoryStorage(), state);
		opened.add(harness);
		await root.configure({ fallbackModels: [alternative] }, context);
		expect(await (await root.submit({ type: "input", content: "question" }, context)).wait(context)).toMatchObject({
			status: "done",
		});
		await root.waitForIdle(context);
		const entries = await allEntries(root);
		const declined = entries.find((entry) => entry.kind === "pi.assistant")!.model![0] as AssistantMessage;
		expect(declined.stopReason).toBe(kind === "text" ? "stop" : "error");
		expect(entries.find((entry) => entry.kind === "pi.model-fallback")?.data).toEqual({
			status: "next",
			model: alternative,
		});
		expect(
			(await root.context(context)).messages.filter((message) => message.role === "assistant").map(textOf),
		).toEqual(["42"]);
		expect(Object.keys((await harness.usage(context)).models).sort()).toEqual(["faux/fallback-1", "faux/faux-1"]);
		await (await root.submit({ type: "input", content: "again" }, context)).wait(context);
		expect(state.faux.state.callCount).toBe(3);
	});

	it("ends exhausted text-refusal chains unanswered without changing the original stop reasons", async () => {
		const state = setup();
		state.faux.setResponses([refusal("text"), refusal("text")]);
		const { harness, root } = await openChat(new MemoryStorage(), state);
		opened.add(harness);
		await root.configure({ fallbackModels: [alternative] }, context);
		expect(await (await root.submit({ type: "input", content: "question" }, context)).wait(context)).toMatchObject({
			status: "unanswered",
			reason: "model_error",
		});
		expect(
			(await allEntries(root))
				.filter((entry) => entry.kind === "pi.assistant")
				.map((entry) => (entry.model![0] as AssistantMessage).stopReason),
		).toEqual(["stop", "stop"]);
		expect((await root.context(context)).messages.map((message) => message.role)).toEqual(["user"]);
	});

	it("keeps fallback opt-in and supports clearing it", async () => {
		const state = setup();
		state.faux.setResponses([refusal("text")]);
		const { harness, root } = await openChat(new MemoryStorage(), state);
		opened.add(harness);
		await root.configure({ fallbackModels: [alternative] }, context);
		await root.configure({ fallbackModels: null }, context);
		expect((await root.agent(context)).fallbackModels).toBeUndefined();
		expect(await (await root.submit({ type: "input", content: "question" }, context)).wait(context)).toMatchObject({
			status: "done",
		});
		expect(state.faux.state.callCount).toBe(1);
	});

	it.each([
		["error", "This user's access has been temporarily limited for suspicious activity related to cybersecurity"],
		["error", "429 insufficient_quota"],
		["error", "invalid argument"],
		["aborted", "cancelled"],
	] as const)("does not fall back for %s: %s", async (stopReason, errorMessage) => {
		const state = setup();
		state.faux.setResponses([fauxAssistantMessage([], { stopReason, errorMessage })]);
		const { harness, root } = await openChat(new MemoryStorage(), state);
		opened.add(harness);
		await root.configure({ fallbackModels: [alternative] }, context);
		expect((await (await root.submit({ type: "input", content: "question" }, context)).wait(context)).status).toBe(
			"unanswered",
		);
		expect(state.faux.state.callCount).toBe(1);
	});

	it("gives each model its own transient retry budget", async () => {
		const state = setup();
		state.settings.retry = { maxRetries: 1, baseDelayMs: 1 };
		const tried: string[] = [];
		state.faux.setResponses(
			[
				fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" }),
				refusal("native"),
				fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" }),
				fauxAssistantMessage("answer"),
			].map(
				(message): FauxResponseStep =>
					(_request, _options, _state, model) => {
						tried.push(model.id);
						return message;
					},
			),
		);
		const { harness, root } = await openChat(new MemoryStorage(), state);
		opened.add(harness);
		await root.configure({ fallbackModels: [alternative] }, context);
		expect((await (await root.submit({ type: "input", content: "question" }, context)).wait(context)).status).toBe(
			"done",
		);
		expect(tried).toEqual([primary.modelId, primary.modelId, alternative.modelId, alternative.modelId]);
	});

	it("reopens at the fallback model even if the host changes the configured chain", async () => {
		const directory = await mkdtemp(join(tmpdir(), "durable-fallback-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const state = setup();
		const busy = unanswered();
		state.faux.setResponses([
			refusal("text"),
			busy.step,
			(_request, _options, _state, model) => {
				expect(model.id).toBe(alternative.modelId);
				return fauxAssistantMessage("recovered");
			},
		]);
		let session = await openChat(await openNodeSqliteStorage(path), state);
		opened.add(session.harness);
		await session.root.configure({ fallbackModels: [alternative] }, context);
		const submission = await session.root.submit({ type: "input", content: "question" }, context);
		await busy.reached;
		await session.harness.close(context);
		session = await openChat(await openNodeSqliteStorage(path), state);
		opened.add(session.harness);
		await session.root.configure({ fallbackModels: null }, context);
		expect((await (await session.harness.submission(submission.id, context))!.wait(context)).status).toBe("done");
		await session.harness.waitForIdle(context);
		expect(state.faux.state.callCount).toBe(3);
		expect((await allEntries(session.root)).filter((entry) => entry.kind === "pi.model-fallback")).toHaveLength(1);
		const fork = await session.root.fork(
			(await allEntries(session.root)).at(-1)!.id,
			{ ownership: { kind: "ownerless" } },
			context,
		);
		expect(
			(await fork.context(context)).messages.filter((message) => message.role === "assistant").map(textOf),
		).toEqual(["recovered"]);
	});

	it("classifies host-recovered refusals and gives the next model a new request identity", async () => {
		const state = setup();
		state.faux.setResponses([
			(_request, _options, _state, model) => {
				expect(model.id).toBe(alternative.modelId);
				return fauxAssistantMessage("answer");
			},
		]);
		const identities: ModelRequestIdentity[] = [];
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: state.models,
				registry: state.registry,
				modelRequests: {
					recover: async (identity) => {
						identities.push(identity);
						return identity.attempt === 1 ? refusal("text") : undefined;
					},
					execute: async (_request, run) => run(),
				},
			},
			context,
		);
		opened.add(harness);
		const root = await harness.root(context, { agent: { model: primary, fallbackModels: [alternative] } });
		expect((await (await root.submit({ type: "input", content: "question" }, context)).wait(context)).status).toBe(
			"done",
		);
		expect(identities.map((identity) => identity.attempt)).toEqual([1, 2]);
		expect(state.faux.state.callCount).toBe(1);
	});

	it("handles refusals returned by deferred polling", async () => {
		const state = chatSetup({
			models: [{ id: primary.modelId }, { id: alternative.modelId }],
			deferred: { pollAfterMs: 1 },
		});
		state.settings.stream = { deferred: true };
		state.faux.setResponses([refusal("text"), fauxAssistantMessage("answer")]);
		const { harness, root } = await openChat(new MemoryStorage(), state);
		opened.add(harness);
		await root.configure({ fallbackModels: [alternative] }, context);
		expect((await (await root.submit({ type: "input", content: "question" }, context)).wait(context)).status).toBe(
			"done",
		);
		expect(state.faux.state.callCount).toBe(2);
		expect(state.faux.state.deferredFetchCount).toBe(2);
	});

	it.each(["answer", "refusal"] as const)("summarization falls back and ends with %s", async (outcome) => {
		const state = setup();
		state.settings.compaction = { enabled: false, keepRecentTokens: 1 };
		state.settings.stream = { nativeTools: { webSearch: true } };
		state.faux.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			refusal("text"),
			(_request, options, _state, model) => {
				expect(model.id).toBe(alternative.modelId);
				expect(options?.nativeTools).toBeUndefined();
				return outcome === "answer" ? fauxAssistantMessage("summary") : refusal("text");
			},
		]);
		const { harness, root } = await openChat(new MemoryStorage(), state);
		opened.add(harness);
		await root.configure({ fallbackModels: [alternative] }, context);
		for (const content of ["first?", "second?"]) {
			await (await root.submit({ type: "input", content }, context)).wait(context);
			await root.waitForIdle(context);
		}
		const task = await harness.waitForTask(await root.compact(undefined, context), context);
		expect(task.state.outcome.status).toBe(outcome === "answer" ? "completed" : "failed");
		await root.waitForIdle(context);
		expect((await allEntries(root)).filter((entry) => entry.kind === "pi.compaction")).toHaveLength(
			outcome === "answer" ? 1 : 0,
		);
		expect(Object.keys((await harness.usage(context)).models).sort()).toEqual(["faux/fallback-1", "faux/faux-1"]);
	});
});
