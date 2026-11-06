import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	Harness,
	MemoryStorage,
	type ModelRequest,
	type ModelRequestIdentity,
	type ModelRequestLifecycle,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, chatSetup, textOf } from "./chat-support.ts";
import { context } from "./session-support.ts";

describe("host model request lifecycle", () => {
	it("recovers a persisted response before interruption without another dispatch", async () => {
		const setup = chatSetup();
		const directory = await mkdtemp(join(tmpdir(), "durable-receipt-"));
		const path = join(directory, "session.sqlite");
		const received = Promise.withResolvers<void>();
		let saved: Awaited<ReturnType<ModelRequestLifecycle["recover"]>>;
		let identity: ModelRequestIdentity | undefined;
		let dispatches = 0;
		let recovering = false;
		setup.faux.setResponses([
			() => {
				dispatches++;
				return fauxAssistantMessage("persisted answer");
			},
		]);
		const modelRequests: ModelRequestLifecycle = {
			recover: async (request) => {
				if (saved) expect(request).toMatchObject({ ...identity, restarts: expect.any(Number) });
				return saved;
			},
			execute: async (request, run, callContext) => {
				expect(recovering).toBe(false);
				const { conversationId, taskId, purpose, attempt, cutoff, restarts } = request;
				identity = { conversationId, taskId, purpose, attempt, cutoff, restarts };
				saved = await run();
				received.resolve();
				await new Promise<void>((resolve) =>
					callContext.abortSignal!.addEventListener("abort", () => resolve(), { once: true }),
				);
				return saved;
			},
		};
		const open = async () =>
			Harness.open(
				await openNodeSqliteStorage(path),
				{
					models: setup.models,
					registry: setup.registry,
					modelRequests,
				},
				context,
			);
		let harness = await open();
		let root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const submission = await root.submit({ type: "input", content: "hello", requestId: "wake" }, context);
		await received.promise;
		await harness.close(context);
		const database = new DatabaseSync(path);
		database
			.prepare(
				"UPDATE tasks SET status = 'running', record = json_set(record, '$.state.status', 'running') WHERE id = ?",
			)
			.run(identity!.taskId);
		database.close();
		recovering = true;
		harness = await open();
		root = await harness.root(context);
		const reopened = await harness.submission(submission.id, context);
		expect(await reopened!.wait(context)).toMatchObject({ status: "done" });
		await harness.waitForIdle(context);
		const answers = (await allEntries(root)).filter((entry) => entry.kind === "pi.assistant");
		expect(answers).toHaveLength(1);
		expect(textOf(answers[0]?.model?.[0])).toBe("persisted answer");
		expect(dispatches).toBe(1);
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	});

	it("attributes compaction through the same host lifecycle", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
			fauxAssistantMessage("summary"),
		]);
		const requests: ModelRequest[] = [];
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: setup.models,
				registry: setup.registry,
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				modelRequests: {
					recover: async () => undefined,
					execute: async (request, run) => {
						requests.push(request);
						return run();
					},
				},
			},
			context,
		);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		for (const content of ["first question", "second question"]) {
			await (await root.submit({ type: "input", content }, context)).wait(context);
			await harness.waitForIdle(context);
		}
		const compaction = await root.compact(undefined, context);
		const completed = await harness.waitForTask(compaction, context);
		expect(completed.state.outcome.status).toBe("completed");
		await harness.waitForIdle(context);
		expect((await allEntries(root)).some((entry) => entry.kind === "pi.compaction")).toBe(true);
		expect(requests.map((request) => request.purpose)).toEqual(["generation", "generation", "compaction"]);
		expect(requests.every((request) => request.taskId > 0 && request.cutoff > 0 && request.attempt === 1)).toBe(true);
		await harness.close(context);
	});

	it("does not dispatch when host admission fails", async () => {
		const setup = chatSetup();
		let dispatched = false;
		setup.faux.setResponses([
			() => {
				dispatched = true;
				return fauxAssistantMessage("unexpected");
			},
		]);
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: setup.models,
				registry: setup.registry,
				modelRequests: {
					recover: async () => undefined,
					execute: async () => {
						throw new Error("admission unavailable");
					},
				},
			},
			context,
		);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const submission = await root.submit({ type: "input", content: "hello" }, context);
		const result = await submission.wait(context);
		expect(result.status).toBe("unanswered");
		expect(dispatched).toBe(false);
		await harness.close(context);
	});
});
