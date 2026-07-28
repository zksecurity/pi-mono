import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxThinking, registerFauxProvider, stream } from "../src/compat.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, ServerToolUse } from "../src/types.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

const serverToolUse: ServerToolUse = {
	type: "serverToolUse",
	id: "srvtoolu_01",
	toolType: "web_search",
	args: { query: "pi mono" },
	response: {
		type: "web_search_tool_result",
		tool_use_id: "srvtoolu_01",
		content: [{ type: "web_search_result", title: "Example", url: "https://example.com" }],
	},
};

/**
 * Rebuild message content the way every proxy does: from stream events, by content
 * index. A producer that mutates `content` without emitting an event leaves a hole
 * here, which is how server-side search blocks were being lost over the wire.
 */
function rebuildContentFromEvents(events: AssistantMessageEvent[]): AssistantMessage["content"] {
	const content: AssistantMessage["content"] = [];
	for (const event of events) {
		switch (event.type) {
			case "text_start":
				content[event.contentIndex] = { type: "text", text: "" };
				break;
			case "text_end":
				content[event.contentIndex] = { type: "text", text: event.content };
				break;
			case "thinking_start":
				content[event.contentIndex] = { type: "thinking", thinking: "" };
				break;
			case "thinking_end":
				content[event.contentIndex] = { type: "thinking", thinking: event.content };
				break;
			case "toolcall_end":
				content[event.contentIndex] = event.toolCall;
				break;
			case "servertooluse":
				content[event.contentIndex] = event.block;
				break;
		}
	}
	return content;
}

describe("serverToolUse stream events", () => {
	it("faux provider announces the block so replayed content has no hole", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage([fauxThinking("first"), serverToolUse, fauxThinking("second"), fauxText("done")]),
		]);

		const context: Context = { messages: [{ role: "user", content: "search", timestamp: Date.now() }] };
		const events: AssistantMessageEvent[] = [];
		const result = stream(registration.getModel(), context);
		for await (const event of result) events.push(event);
		const final = await result.result();

		expect(events.some((e) => e.type === "servertooluse")).toBe(true);

		const rebuilt = rebuildContentFromEvents(events);
		// No hole: every index is populated, and the block survives in position.
		expect(rebuilt.every((block) => block !== undefined)).toBe(true);
		expect(rebuilt.map((b) => b.type)).toEqual(["thinking", "serverToolUse", "thinking", "text"]);
		expect(rebuilt[1]).toEqual(serverToolUse);
		// The event-rebuilt content matches what the direct (non-proxied) path produced.
		expect(rebuilt).toEqual(final.content);
	});
});
