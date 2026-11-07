import type { Draft } from "@earendil-works/chord/delta";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { getDeclinedAttempts } from "@earendil-works/pi-ai/utils/fallback";
import { defineDoc } from "../documents.ts";
import type { ConversationId, Tx } from "../types.ts";

/** Ledger of one conversation's own spend: its entries, and compaction summarization attempts, which have none. */
export type UsageState = {
	/** Assistant entries and summarization attempts, keyed `provider/modelId`. */
	models: Record<string, JsonRepresentation<Usage>>;
	/** Tool results, keyed by tool name; their usage has no model identity. */
	tools: Record<string, JsonRepresentation<Usage>>;
};

export const UsageDoc = defineDoc<UsageState>({
	kind: "pi.usage",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ models: {}, tools: {} }),
	checkpointWhen: () => true,
});

/** Record the serving model and any declined attempts carried by a host's model wrapper. */
export async function recordModelUsage(
	tx: Tx,
	conversationId: ConversationId,
	message: AssistantMessage,
): Promise<void> {
	await recordUsage(tx, conversationId, "models", `${message.provider}/${message.model}`, message.usage);
	for (const attempt of getDeclinedAttempts(message)) {
		await recordUsage(tx, conversationId, "models", `${attempt.provider}/${attempt.model}`, attempt.usage);
	}
}

/** Add `usage` to one bucket of the conversation's `pi.usage`, in the commit that records the response. */
export async function recordUsage(
	tx: Tx,
	conversationId: ConversationId,
	bucket: keyof UsageState,
	key: string,
	usage: Usage,
): Promise<void> {
	const totals = (await tx.doc(UsageDoc, conversationId))[bucket];
	// Own keys only: a tool may be called `toString`.
	const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
	// Providers may leave optional counters `undefined`; drafts take strict JSON.
	if (total === undefined)
		totals[key] = copyJson(usage, { omitUndefinedProperties: true }) as JsonRepresentation<Usage>;
	else addUsage(total, usage);
}

/** Add every counter of `usage` to `total`; optional counters are added once either side reports them. */
export function addUsage(total: Draft<Usage> | Usage, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	if (usage.extras !== undefined) total.extras = addExtras(total.extras, usage.extras);
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
	if (usage.cost.extras !== undefined) total.cost.extras = addExtras(total.cost.extras, usage.cost.extras);
}

/** Sum named counters, including keys that also exist on Object.prototype. */
function addExtras(total: Record<string, number> | undefined, extras: Record<string, number>): Record<string, number> {
	const sum = { ...total };
	for (const [key, value] of Object.entries(extras)) {
		Object.defineProperty(sum, key, {
			value: (Object.hasOwn(sum, key) ? sum[key]! : 0) + value,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return sum;
}

/** Add every bucket of `state` into `sum`. */
export function addUsageState(sum: UsageState, state: Readonly<UsageState>): void {
	for (const bucket of ["models", "tools"] as const) {
		for (const [key, usage] of Object.entries(state[bucket])) {
			const total = Object.hasOwn(sum[bucket], key) ? sum[bucket][key] : undefined;
			// Define rather than assign: assigning a tool named `__proto__` would set the prototype.
			if (total !== undefined) addUsage(total, usage);
			else
				Object.defineProperty(sum[bucket], key, {
					value: structuredClone(usage),
					enumerable: true,
					writable: true,
				});
		}
	}
}
