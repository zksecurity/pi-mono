// The model chain pinned to one generation or summarization, and transcript edits excluding declined answers.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRefusal } from "@earendil-works/pi-ai/utils/refusal";
import type { ConversationId, EntryId, Tx } from "../types.ts";
import type { ModelRef } from "./types.ts";

/** Pinned model choices and current position, stored in the requesting task's checkpoint. */
export type ModelFallback = { models: ModelRef[]; index: number; firstAttempt: number };

/** Pin an explicitly configured chain; no alternatives means fallback is disabled. */
export function prepareFallback(
	model: ModelRef,
	alternatives: readonly ModelRef[] | undefined,
): ModelFallback | undefined {
	return alternatives?.length ? { models: [model, ...alternatives], index: 0, firstAttempt: 1 } : undefined;
}

/** Classify a refusal only when fallback is enabled; cancellation never advances the chain. */
export function fallbackRefusal(
	message: AssistantMessage,
	fallback: ModelFallback | undefined,
): fallback is ModelFallback {
	return fallback !== undefined && message.stopReason !== "aborted" && isRefusal(message);
}

/** Move to the next pinned model, or report that the chain is exhausted. */
export function nextFallback(fallback: ModelFallback, attempt: number): ModelFallback | undefined {
	return fallback.index + 1 < fallback.models.length
		? { ...fallback, index: fallback.index + 1, firstAttempt: attempt + 1 }
		: undefined;
}

/** Give each model its own retry budget while keeping host request identities unique across the chain. */
export function fallbackAttempt(fallback: ModelFallback | undefined, attempt: number): number {
	return attempt - (fallback?.firstAttempt ?? 1) + 1;
}

/** Keep the original provider response in history while excluding it from subsequent model context. */
export async function omitRefusal(
	tx: Tx,
	conversationId: ConversationId,
	entry: EntryId,
	next: ModelFallback | undefined,
): Promise<void> {
	const model = next?.models[next.index];
	await tx.appendEntry(conversationId, {
		kind: "pi.model-fallback",
		data: model === undefined ? { status: "exhausted" } : { status: "next", model: { ...model } },
		edits: [{ target: entry, action: "omit" }],
	});
}
