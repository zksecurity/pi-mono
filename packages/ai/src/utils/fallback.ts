import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderId, Usage } from "../types.ts";
import { type AssistantMessageDiagnostic, appendAssistantMessageDiagnostic } from "./diagnostics.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";
import { isRefusal } from "./refusal.ts";
import { type RetryCallbacks, type RetryPolicy, retryAssistantCall } from "./retry.ts";

/**
 * Hardcoded per-provider downgrade chains, each listed strongest-first.
 *
 * A chain answers one question: "this model declined the request — which model
 * should try next?" The answer is simply whatever follows it in its chain, so a
 * model's successors are written down once rather than repeated for every model
 * above it. Entries are model ids within the same provider, so the caller's
 * credential and auth path stay unchanged across the whole chain.
 *
 * Chains stay inside a model family (opus downgrades to opus, gpt-5.x to
 * gpt-5.x) so a fallback trades recency for permissiveness without also
 * trading away the capability tier the caller chose.
 *
 * A provider may hold several chains. Where families branch at the top — the
 * three gpt-5.6 variants all descend into the same tail — each head gets its
 * own chain and the shared tail is repeated. {@link getDowngradeChainIds}
 * takes the first chain containing the model, so repeated tails must agree;
 * `model-fallback.test.ts` asserts that they do.
 *
 * Ids that a caller's registry does not expose are dropped at resolve time by
 * {@link resolveDowngradeChain}, so a chain may safely list a model that only
 * some providers serve.
 */
export const MODEL_DOWNGRADE_CHAINS: Readonly<Record<string, readonly (readonly string[])[]>> = {
	anthropic: [
		["claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"],
		["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"],
	],
	openai: [
		["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.2"],
		["gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.2"],
		["gpt-5.6-terra", "gpt-5.5", "gpt-5.4", "gpt-5.2"],
	],
	// `openai-codex` serves a subset of the `openai` catalog — `gpt-5.2` is not
	// in it, so these chains stop one step earlier.
	"openai-codex": [
		["gpt-5.6-sol", "gpt-5.5", "gpt-5.4"],
		["gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
		["gpt-5.6-terra", "gpt-5.5", "gpt-5.4"],
	],
};

/**
 * Look up what a provider/model pair should downgrade to, in order.
 *
 * Returns the ids following `modelId` in the first chain that contains it —
 * model ids only, so use {@link resolveDowngradeChain} to turn them into
 * `Model` objects against a registry. Returns an empty array both for a model
 * with no chain and for the weakest model in one; in either case there is
 * nothing below it to try.
 */
export function getDowngradeChainIds(provider: ProviderId, modelId: string): string[] {
	for (const chain of MODEL_DOWNGRADE_CHAINS[provider] ?? []) {
		const index = chain.indexOf(modelId);
		if (index !== -1) return chain.slice(index + 1);
	}
	return [];
}

/**
 * Resolve `model` plus its downgrade chain into a list of models to try in
 * order, starting with `model` itself.
 *
 * `lookup` is the caller's registry accessor. Chain entries it cannot resolve
 * are skipped rather than erroring, so a chain shared across providers that
 * serve overlapping-but-unequal catalogs degrades to whatever is actually
 * available.
 */
export function resolveDowngradeChain<TApi extends Api>(
	model: Model<TApi>,
	lookup: (provider: ProviderId, modelId: string) => Model<TApi> | undefined,
): Model<TApi>[] {
	const resolved: Model<TApi>[] = [model];
	for (const id of getDowngradeChainIds(model.provider, model.id)) {
		const next = lookup(model.provider, id);
		if (next) resolved.push(next);
	}
	return resolved;
}

/** Callbacks emitted by {@link streamWithModelFallback} around each downgrade. */
export interface ModelFallbackCallbacks {
	/**
	 * Emitted after `from` declines and before `to` is tried. `attempt` is
	 * 1-indexed over downgrades, not over models.
	 */
	onFallback?: <TApi extends Api>(
		from: Model<TApi>,
		to: Model<TApi>,
		attempt: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted once when the chain ends, successfully or not. */
	onFallbackFinished?: <TApi extends Api>(
		success: boolean,
		servingModel: Model<TApi> | undefined,
		declined: number,
	) => void | Promise<void>;
}

export interface ModelFallbackOptions<TApi extends Api> {
	/** Models to try in order. Usually built by {@link resolveDowngradeChain}. */
	models: Model<TApi>[];
	/**
	 * Decides whether a failed response should move to the next model.
	 *
	 * Defaults to {@link isRefusal}: content-scoped refusals only. Account-scoped
	 * restrictions are deliberately excluded — those fail identically on every
	 * model reachable with the same credential, so walking the chain just burns
	 * attempts. Quota exhaustion is excluded for the same reason: on a pooled
	 * subscription it is a signal to switch credentials before it is a signal to
	 * switch models.
	 */
	shouldFallback?: (message: AssistantMessage) => boolean;
	/** Transient-error retry policy applied independently to each model. */
	retry?: RetryPolicy;
	signal?: AbortSignal;
	retryCallbacks?: RetryCallbacks;
	fallbackCallbacks?: ModelFallbackCallbacks;
}

/** The `type` carried by every diagnostic {@link streamWithModelFallback} appends. */
export const MODEL_FALLBACK_DIAGNOSTIC_TYPE = "model_fallback";

/** One model that declined the request before the chain moved on. */
export interface DeclinedAttempt {
	/** 1-indexed position in the sequence of declines, not in the model chain. */
	attempt: number;
	provider: ProviderId;
	model: string;
	errorMessage: string;
	usage: Usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Read back the models that declined before the returned message was produced.
 *
 * Declined attempts are not folded into the message's top-level `usage`: that
 * field is priced by the serving model's adapter, and a declined hop ran on a
 * different model at different rates (some, like an Anthropic pre-output
 * classifier block, are not billed at all). Summing them would silently corrupt
 * per-model cost math for every existing consumer of `usage`.
 *
 * Use this accessor for spend accounting that must cover the whole chain, and
 * {@link sumUsage} to total it with the serving model's usage.
 */
export function getDeclinedAttempts(message: AssistantMessage): DeclinedAttempt[] {
	const attempts: DeclinedAttempt[] = [];
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== MODEL_FALLBACK_DIAGNOSTIC_TYPE) continue;
		const details = diagnostic.details;
		if (!isRecord(details) || !isRecord(details.usage)) continue;
		attempts.push({
			attempt: typeof details.attempt === "number" ? details.attempt : attempts.length + 1,
			provider: String(details.provider ?? ""),
			model: String(details.model ?? ""),
			errorMessage: diagnostic.error?.message ?? "Unknown error",
			usage: withCost(details.usage as unknown as Usage),
		});
	}
	return attempts;
}

/**
 * Guarantee a `cost` block on a declined attempt's usage.
 *
 * Each attempt's usage is captured as its own adapter produced it, so `cost` is
 * priced at that model's rates — not the serving model's. A ledger reading
 * `usage.cost.total` must never hit `undefined` here, so a usage that somehow
 * arrives without the block (a provider that never called `calculateCost`, or a
 * message rehydrated from older persisted state) gets a zeroed one rather than
 * throwing at the call site.
 */
function withCost(usage: Usage): Usage {
	if (isRecord(usage.cost)) return usage;
	return { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/**
 * Add up token counts and costs across several `Usage` records.
 *
 * Intended for budget accounting across a fallback chain:
 * `sumUsage(message.usage, ...getDeclinedAttempts(message).map((a) => a.usage))`.
 *
 * Optional per-provider fields are summed only when at least one input reports
 * them, so a total stays `undefined` rather than a misleading `0` when no
 * provider in the chain broke that number out.
 */
export function sumUsage(...usages: Usage[]): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	for (const usage of usages) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
		if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
		for (const [key, value] of Object.entries(usage.extras ?? {})) {
			total.extras = { ...total.extras, [key]: (total.extras?.[key] ?? 0) + value };
		}

		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
		for (const [key, value] of Object.entries(usage.cost.extras ?? {})) {
			total.cost.extras = { ...total.cost.extras, [key]: (total.cost.extras?.[key] ?? 0) + value };
		}
	}

	return total;
}

function declinedDiagnostic<TApi extends Api>(
	model: Model<TApi>,
	response: AssistantMessage,
	attempt: number,
): AssistantMessageDiagnostic {
	return {
		type: MODEL_FALLBACK_DIAGNOSTIC_TYPE,
		timestamp: Date.now(),
		error: { name: "ModelDeclined", message: response.errorMessage || "Unknown error" },
		details: {
			attempt,
			provider: model.provider,
			model: model.id,
			// Declined attempts are billed by some providers (OpenAI generates the
			// refusal) and not by others (an Anthropic pre-output classifier block
			// is unbilled), so keep the per-attempt usage rather than summing it
			// into the serving model's, whose rates do not apply to it.
			usage: response.usage,
		},
	};
}

/**
 * Run an assistant-producing call against a chain of models, moving to the next
 * model when one declines the request.
 *
 * Composition is deliberate: transient retry runs *inside* each model (via
 * {@link retryAssistantCall}), and fallback runs *outside* it. Re-sending
 * refused content to the model that just refused it earns the same refusal, so
 * a refusal must never be a retry trigger — only a fallback trigger. The two
 * classifiers are kept disjoint for this reason: refusal patterns live in
 * `refusal.ts` and are absent from `RETRYABLE_PROVIDER_ERROR_PATTERN`.
 *
 * The returned message reports what actually happened:
 * - `responseModel` names the model that served the turn, when it is not the
 *   one first requested.
 * - One `model_fallback` diagnostic is appended per declined hop, carrying that
 *   hop's model, error message, and usage. Read these back with
 *   {@link getDeclinedAttempts} rather than parsing diagnostics by hand.
 * - Top-level `usage` remains the serving model's, correctly priced by its own
 *   adapter. For chain-wide spend, total it yourself:
 *   `sumUsage(result.usage, ...getDeclinedAttempts(result).map((a) => a.usage))`.
 *
 * Aborts are terminal and never walk the chain. A failure that
 * `shouldFallback` rejects is returned immediately, so deterministic errors
 * still fail fast instead of being re-tried down every model in the list.
 */
export async function streamWithModelFallback<TApi extends Api>(
	produce: (model: Model<TApi>) => Promise<AssistantMessage>,
	options: ModelFallbackOptions<TApi>,
): Promise<AssistantMessage> {
	const { models, retry, signal, retryCallbacks, fallbackCallbacks } = options;
	if (models.length === 0) throw new Error("streamWithModelFallback requires at least one model");
	const shouldFallback = options.shouldFallback ?? isRefusal;

	const requested = models[0];
	const diagnostics: AssistantMessageDiagnostic[] = [];

	for (let i = 0; i < models.length; i++) {
		const model = models[i];
		const response = await retryAssistantCall(() => produce(model), retry, signal, retryCallbacks);

		const isFailure = response.stopReason === "error";
		const canFallback = isFailure && shouldFallback(response) && i < models.length - 1;

		if (!canFallback) {
			for (const diagnostic of diagnostics) appendAssistantMessageDiagnostic(response, diagnostic);
			if (diagnostics.length > 0 && model.id !== requested.id) response.responseModel = model.id;
			await fallbackCallbacks?.onFallbackFinished?.(!isFailure, model, diagnostics.length);
			return response;
		}

		diagnostics.push(declinedDiagnostic(model, response, diagnostics.length + 1));
		await fallbackCallbacks?.onFallback?.(
			model,
			models[i + 1],
			diagnostics.length,
			response.errorMessage || "Unknown error",
		);
	}

	// Unreachable: the loop always returns on its final iteration, because
	// `canFallback` requires `i < models.length - 1`.
	throw new Error("streamWithModelFallback exhausted its model chain without returning");
}

/** Build the terminal event matching a final message's stop reason. */
function terminalEvent(message: AssistantMessage): AssistantMessageEvent {
	return message.stopReason === "error" || message.stopReason === "aborted"
		? { type: "error", reason: message.stopReason, error: message }
		: { type: "done", reason: message.stopReason, message };
}

function synthesizeFailure<TApi extends Api>(model: Model<TApi>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * Streaming form of {@link streamWithModelFallback}: returns an event stream
 * immediately and forwards each attempt's events as they arrive, instead of
 * buffering the turn and emitting it at the end.
 *
 * Use this whenever anything downstream watches for liveness. A buffered
 * fallback emits nothing until the whole chain settles, so a long but healthy
 * turn looks indistinguishable from a hung one to an inactivity watchdog or a
 * live log view.
 *
 * Fallback and retry semantics are identical to {@link streamWithModelFallback},
 * including the returned message's `responseModel` and `model_fallback`
 * diagnostics. Two rules govern what reaches the outer stream, both forced by
 * how consumers read it:
 *
 * - **Exactly one `start` is forwarded**, from whichever attempt emits the first
 *   one. `agent-loop` appends a new message to the conversation on every `start`,
 *   so forwarding a second would duplicate the assistant turn.
 * - **A discarded attempt's `done`/`error` is swallowed.** `EventStream` latches
 *   on the first terminal event and ignores everything after it, so forwarding a
 *   refused attempt's terminal would freeze the result on the refusal and drop
 *   the model that actually answered.
 *
 * Everything in between — text, thinking, tool calls — is forwarded live from
 * every attempt, including ones later discarded. Each carries its own `partial`,
 * so a consumer that replaces state per event converges on the serving attempt.
 *
 * **Consequence worth knowing:** if an attempt emits output before being
 * refused, that output has already been forwarded and may have been logged or
 * displayed, even though it belongs to a discarded turn. In practice the
 * refusals this handles arrive before any output — Anthropic's classifier blocks
 * pre-generation, and a Codex block throws before the first event — but a
 * mid-stream refusal would leak text from a turn that never completed.
 */
export function streamWithModelFallbackEvents<TApi extends Api>(
	produce: (model: Model<TApi>) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
	options: ModelFallbackOptions<TApi>,
): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	const { models, retry, signal, retryCallbacks, fallbackCallbacks } = options;
	const shouldFallback = options.shouldFallback ?? isRefusal;

	(async () => {
		if (models.length === 0) throw new Error("streamWithModelFallbackEvents requires at least one model");

		const requested = models[0];
		const diagnostics: AssistantMessageDiagnostic[] = [];
		let startForwarded = false;

		// One attempt: forward its events live and return its final message. Used
		// as retryAssistantCall's `produce`, so transient retries re-enter here and
		// their events are forwarded too.
		const runOnce = async (model: Model<TApi>): Promise<AssistantMessage> => {
			let inner: AssistantMessageEventStream;
			try {
				inner = await produce(model);
			} catch (error) {
				return synthesizeFailure(model, error);
			}

			let terminal: AssistantMessage | undefined;
			try {
				for await (const event of inner) {
					if (event.type === "done") {
						terminal = event.message;
						break;
					}
					if (event.type === "error") {
						terminal = event.error;
						break;
					}
					if (event.type === "start") {
						if (startForwarded) continue;
						startForwarded = true;
					}
					out.push(event);
				}
			} catch (error) {
				return synthesizeFailure(model, error);
			}
			return terminal ?? (await inner.result());
		};

		for (let i = 0; i < models.length; i++) {
			const model = models[i];
			const response = await retryAssistantCall(() => runOnce(model), retry, signal, retryCallbacks);

			const isFailure = response.stopReason === "error";
			const canFallback = isFailure && shouldFallback(response) && i < models.length - 1;

			if (!canFallback) {
				for (const diagnostic of diagnostics) appendAssistantMessageDiagnostic(response, diagnostic);
				if (diagnostics.length > 0 && model.id !== requested.id) response.responseModel = model.id;
				await fallbackCallbacks?.onFallbackFinished?.(!isFailure, model, diagnostics.length);
				out.push(terminalEvent(response));
				out.end(response);
				return;
			}

			diagnostics.push(declinedDiagnostic(model, response, diagnostics.length + 1));
			await fallbackCallbacks?.onFallback?.(
				model,
				models[i + 1],
				diagnostics.length,
				response.errorMessage || "Unknown error",
			);
		}
	})().catch((error) => {
		const failure = synthesizeFailure(models[0] ?? ({ api: "", provider: "", id: "" } as Model<TApi>), error);
		out.push(terminalEvent(failure));
		out.end(failure);
	});

	return out;
}
