// Provider-native search configuration and transcript replay across reopen and fork.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxServerToolUse } from "@earendil-works/pi-ai";
import { type Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat, unanswered, waitFor } from "./chat-support.ts";
import { addTool, tool } from "./harness-support.ts";
import { context } from "./session-support.ts";

const opened = new Set<Harness>();
const directories = new Set<string>();

afterEach(async () => {
	for (const harness of opened) await harness.close(context);
	opened.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

describe("durable native web search", () => {
	it("forwards search options and replays server-tool blocks after reopen and fork", async () => {
		const directory = await mkdtemp(join(tmpdir(), "durable-search-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const state = chatSetup();
		const nativeTools = { webSearch: { allowedDomains: ["example.com"], maxUses: 2 } };
		state.settings.stream = { nativeTools };
		const block = fauxServerToolUse(
			"web_search",
			{ query: "question" },
			{ type: "web_search_tool_result", content: [] },
			"search-1",
		);
		state.faux.setResponses([
			(_request, options) => {
				expect(options?.nativeTools).toEqual(nativeTools);
				return fauxAssistantMessage([block, { type: "text", text: "found" }]);
			},
			...["reopened", "forked"].map(
				(text): FauxResponseStep =>
					(request, options) => {
						expect(options?.nativeTools).toEqual(nativeTools);
						expect(
							request.messages.flatMap((message) =>
								message.role === "assistant"
									? message.content.filter((content) => content.type === "serverToolUse")
									: [],
							),
						).toEqual([block]);
						return fauxAssistantMessage(text);
					},
			),
		]);
		let session = await openChat(await openNodeSqliteStorage(path), state);
		opened.add(session.harness);
		await (await session.root.submit({ type: "input", content: "search" }, context)).wait(context);
		await session.root.waitForIdle(context);
		const answer = (await allEntries(session.root)).at(-1)!;
		await session.harness.close(context);
		session = await openChat(await openNodeSqliteStorage(path), state);
		opened.add(session.harness);
		await (await session.root.submit({ type: "input", content: "follow up" }, context)).wait(context);
		const fork = await session.root.fork(answer.id, { ownership: { kind: "ownerless" } }, context);
		await (await fork.submit({ type: "input", content: "branch" }, context)).wait(context);
		expect(state.faux.state.callCount).toBe(3);
	});

	it("pins search options for an interrupted request", async () => {
		const directory = await mkdtemp(join(tmpdir(), "durable-search-pinned-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const state = chatSetup();
		state.settings.stream = { nativeTools: { webSearch: { maxUses: 1 } } };
		const busy = unanswered();
		state.faux.setResponses([
			busy.step,
			(_request, options) => {
				expect(options?.nativeTools).toEqual({ webSearch: { maxUses: 1 } });
				return fauxAssistantMessage("recovered");
			},
		]);
		let session = await openChat(await openNodeSqliteStorage(path), state);
		opened.add(session.harness);
		const submission = await session.root.submit({ type: "input", content: "search" }, context);
		await busy.reached;
		await session.harness.close(context);
		state.settings.stream = { nativeTools: { webSearch: { maxUses: 9 } } };
		session = await openChat(await openNodeSqliteStorage(path), state);
		opened.add(session.harness);
		expect((await (await session.harness.submission(submission.id, context))!.wait(context)).status).toBe("done");
	});

	it("rejects client-tool name collisions before dispatch", async () => {
		const state = chatSetup();
		state.settings.stream = { nativeTools: { webSearch: true } };
		addTool(state.registry, tool("web_search"));
		const { harness, root } = await openChat(new MemoryStorage(), state);
		opened.add(harness);
		expect((await (await root.submit({ type: "input", content: "search" }, context)).wait(context)).status).toBe(
			"unanswered",
		);
		expect(state.faux.state.callCount).toBe(0);
		await waitFor(() => state.reports.length > 0);
		expect(state.reports).toContainEqual(expect.objectContaining({ message: expect.stringContaining("collides") }));
	});
});
