import type { AssistantMessage } from "../types.ts";

/**
 * Regex patterns to detect *content-scoped* refusals: a provider declined this
 * specific request because of what was in it.
 *
 * These are worth retrying on a different model, because the decision is made
 * per-request by a classifier whose thresholds differ between models. They are
 * NOT worth retrying on the same model — a re-send of the same content earns
 * the same refusal, which is why refusal patterns are deliberately kept out of
 * `RETRYABLE_PROVIDER_ERROR_PATTERN` in `retry.ts`.
 *
 * Fallback for older messages and providers without a native refusal signal.
 * Native signals take precedence over these error-message patterns.
 *
 * Provider-specific patterns (with example error messages):
 *
 * - Anthropic (classifier block, `stop_details.explanation`): "This request
 *   triggered restrictions on violative cyber content and was blocked under
 *   Anthropic's Usage Policy."
 * - Anthropic (no explanation supplied): "The model refused to complete the request"
 * - OpenAI Codex (`CodexApiError`, subscription path): "Codex error: This content
 *   was flagged for possible cybersecurity risk. If this seems wrong, try
 *   rephrasing your request. To get authorized for security work, join the
 *   Trusted Access for Cyber program: https://chatgpt.com/cyber"
 * - OpenAI Responses (metered path): the same sentence with no prefix.
 * - OpenAI Completions: "Provider finish_reason: content_filter"
 *
 * Anthropic's second safety stop reason, `"sensitive"`, is also covered.
 * `mapStopReason` in `api/anthropic-messages.ts` renders it as "Provider stopped
 * with: sensitive", which is adapter wording rather than anything the provider
 * sends — if that string changes, the matching pattern here has to change with
 * it. (Older builds produced `stopReason: "error"` with no message at all, which
 * surfaced as "An unknown error occurred" and was invisible to any classifier.)
 */
const REFUSAL_PATTERNS = [
	// Anthropic safety classifiers.
	/triggered restrictions on violative/i,
	/blocked under anthropic'?s usage policy/i,
	/refused to complete the request/i,
	// Anthropic's other safety stop reason, "sensitive". The wording comes from
	// mapStopReason in api/anthropic-messages.ts, not from the wire.
	/stopped with: sensitive/i,

	// OpenAI / Codex cybersecurity blocks. All three wordings observed in the
	// wild share at least one of these fragments.
	/flagged for possible cybersecurity risk/i,
	/trusted access for cyber/i,
	/chatgpt\.com\/cyber/i,

	// OpenAI-compatible providers surfacing a content filter as a finish reason.
	/\bcontent_filter\b/i,
];

/**
 * Patterns for *account-scoped* restrictions: the credential, not the request,
 * is what the provider objected to.
 *
 * These look superficially like refusals and must not be treated as such.
 * Downgrading the model and retrying on the same credential will fail again —
 * the correct response is to switch credentials or quarantine the account.
 *
 * Example (OpenAI): "This user's access to gpt-5.2-codex has been temporarily
 * limited for potentially suspicious activity related to cybersecurity. Learn
 * more about our safety mitigations:
 * https://platform.openai.com/docs/guides/safety-checks/cybersecurity"
 */
const ACCOUNT_RESTRICTION_PATTERNS = [
	/suspicious activity related to cybersecurity/i,
	/safety-checks\/cybersecurity/i,
	/access to .{1,80} has been temporarily limited/i,
];

function matches(patterns: RegExp[], errorMessage: string): boolean {
	return patterns.some((pattern) => pattern.test(errorMessage));
}

/**
 * Check whether an assistant message is a content-scoped refusal that a
 * different model might accept.
 *
 * Returns `false` for account-scoped restrictions ({@link isAccountRestriction}),
 * which are excluded explicitly so a caller that only checks this function never
 * walks a downgrade chain that cannot succeed.
 *
 * ## Custom providers
 *
 * Custom adapters should set `refusal` from native signals. Error patterns and
 * conservative text-decline detection cover messages without that field.
 */
export function isRefusal(message: AssistantMessage): boolean {
	return classifyRefusal(message)?.kind === "refusal";
}

/**
 * Check whether a failed assistant message reports an account- or
 * credential-scoped restriction rather than a per-request refusal.
 *
 * Callers should treat this as a signal to switch credentials, not models.
 */
export function isAccountRestriction(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	return matches(ACCOUNT_RESTRICTION_PATTERNS, message.errorMessage);
}

/** Mutually exclusive classification of an assistant message. */
export type RefusalKind = "refusal" | "accountRestriction";

export interface RefusalClassification {
	kind: RefusalKind;
	source: NonNullable<AssistantMessage["refusal"]>["source"] | "pattern" | "text";
	/** Normalized phrase and rule that matched, populated for text refusals. */
	textMatch?: { ruleId: string; phrase: string };
}

/** Displayable literal phrases used by the text classifier, not model-specific rules. */
export interface TextRefusalPattern {
	id: string;
	description: string;
	phrases: string[];
	/** Word boundaries exclude e.g. "helpfully"; sentence boundaries require '.', '!', or the end. */
	boundary: "word" | "sentence";
	location: "opening" | "after-offer";
}

const DECLINE_PREFIXES = [
	"i can't",
	"i cant",
	"i cannot",
	"i won't",
	"i will not",
	"i am unable to",
	"i'm unable to",
	"i am not able to",
	"i'm not able to",
	"i must decline to",
	"i'm not going to",
];
const EMPHATIC_DECLINE_PREFIXES = DECLINE_PREFIXES.flatMap((prefix) => [
	prefix,
	`${prefix} and won't`,
	`${prefix} and will not`,
]);

function declinePhrases(actions: string[]): string[] {
	return EMPHATIC_DECLINE_PREFIXES.flatMap((prefix) => actions.map((action) => `${prefix} ${action}`));
}

const TEXT_REFUSAL_PATTERNS: TextRefusalPattern[] = [
	{
		id: "decline-assistance",
		description: "An opening decline to help, assist, comply, fulfill, fulfil, or support.",
		phrases: declinePhrases(["help", "assist", "comply", "fulfill", "fulfil", "support"]),
		boundary: "word",
		location: "opening",
	},
	{
		id: "decline-request",
		description: "A complete opening decline to do this/that/it or provide guidance on that.",
		phrases: declinePhrases(["do this", "do that", "do it", "provide guidance on that"]),
		boundary: "sentence",
		location: "opening",
	},
	{
		id: "decline-harmful-guidance",
		description: "A decline to provide harmful guidance; 'I can't provide' alone is not sufficient.",
		phrases: declinePhrases([
			...["information or guidance", "information"].flatMap((object) =>
				["illegal", "harmful", "illegal or harmful"].map(
					(activity) => `provide ${object} on ${activity} activities`,
				),
			),
			...["for", "on how to"].flatMap((preposition) =>
				["creating malicious software", "harm others", "hacking", "compromising"].map(
					(action) => `provide instructions ${preposition} ${action}`,
				),
			),
		]),
		boundary: "word",
		location: "opening",
	},
	{
		id: "decline-after-offer",
		description:
			"After 'I'm here to help …, but hacking into …' in the opening sentence; each gap is at most 160 characters.",
		phrases: ["is not something i can assist with"],
		boundary: "sentence",
		location: "after-offer",
	},
];

/**
 * Return independent, JSON-serializable copies of the active text rules for UI display.
 * Matching folds case, curly apostrophes, and whitespace. Opening rules allow an
 * apology, "No.", or "I understand …, but" before the phrase. All rules require
 * stopReason "stop" and no tool calls. Only the opening is matched; the total
 * response length does not affect classification.
 */
export function getTextRefusalPatterns(): TextRefusalPattern[] {
	return TEXT_REFUSAL_PATTERNS.map((pattern) => ({ ...pattern, phrases: [...pattern.phrases] }));
}

function isShortClause(text: string): boolean {
	return text.length > 0 && text.length <= 160 && ![".", "!", "?", "\n"].some((mark) => text.includes(mark));
}

function phraseMatches(text: string, phrase: string, boundary: TextRefusalPattern["boundary"]): boolean {
	if (!text.startsWith(phrase)) return false;
	const rest = text.slice(phrase.length);
	if (boundary === "sentence") {
		const trimmed = rest.trimStart();
		return trimmed === "" || trimmed.startsWith(".") || trimmed.startsWith("!");
	}
	const next = rest.charAt(0);
	return next === "" || !"abcdefghijklmnopqrstuvwxyz0123456789_".includes(next);
}

/**
 * Classify an assistant message, or return `undefined` when it is neither
 * a refusal nor an account restriction.
 *
 * Account restrictions are checked first: their wording also mentions
 * cybersecurity, and misreading one as a refusal would send the caller down a
 * downgrade chain that fails at every hop.
 */
export function classifyRefusal(message: AssistantMessage): RefusalClassification | undefined {
	if (isAccountRestriction(message)) return { kind: "accountRestriction", source: "pattern" };
	if (message.refusal) return { kind: "refusal", source: message.refusal.source };
	if (message.stopReason === "error" && message.errorMessage && matches(REFUSAL_PATTERNS, message.errorMessage)) {
		return { kind: "refusal", source: "pattern" };
	}
	if (message.stopReason !== "stop" || message.content.some((block) => block.type === "toolCall")) return undefined;
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim()
		.replace(/^[*_#>\s]+/, "");
	// Regex is used only for whitespace normalization, not refusal matching.
	const normalized = text
		.toLowerCase()
		.replaceAll("’", "'")
		.replace(/[^\S\n]+/g, " ");
	let opening = normalized;
	const acknowledgementEnd = opening.indexOf(", but ");
	if (
		opening.startsWith("i understand ") &&
		acknowledgementEnd > 13 &&
		isShortClause(opening.slice(13, acknowledgementEnd))
	) {
		opening = opening.slice(acknowledgementEnd + 6);
	} else {
		const preamble = ["i'm sorry,", "i'm sorry", "sorry,", "sorry", "no."].find(
			(prefix) => opening.startsWith(`${prefix} `) || opening.startsWith(`${prefix}\n`),
		);
		if (preamble) {
			opening = opening.slice(preamble.length).trimStart();
			if (opening.startsWith("but ")) opening = opening.slice(4);
		}
	}
	opening = opening.replace(/\s+/g, " ");
	let afterOffer: string | undefined;
	const offerStart = "i'm here to help ";
	const offerSeparator = ", but hacking into ";
	const offerEnd = normalized.indexOf(offerSeparator);
	const refusalStart = normalized.indexOf(" is not something i can assist with", offerEnd + offerSeparator.length);
	if (
		normalized.startsWith(offerStart) &&
		offerEnd >= 0 &&
		refusalStart >= 0 &&
		isShortClause(normalized.slice(offerStart.length, offerEnd)) &&
		isShortClause(normalized.slice(offerEnd + offerSeparator.length, refusalStart))
	) {
		afterOffer = normalized.slice(refusalStart + 1);
	}
	for (const pattern of TEXT_REFUSAL_PATTERNS) {
		const candidate = pattern.location === "opening" ? opening : afterOffer;
		if (candidate === undefined) continue;
		const phrase = pattern.phrases.find((phrase) => phraseMatches(candidate, phrase, pattern.boundary));
		if (phrase) return { kind: "refusal", source: "text", textMatch: { ruleId: pattern.id, phrase } };
	}
	return undefined;
}

/** Get the content-scoped refusal patterns for testing purposes. */
export function getRefusalPatterns(): RegExp[] {
	return [...REFUSAL_PATTERNS];
}

/** Get the account-scoped restriction patterns for testing purposes. */
export function getAccountRestrictionPatterns(): RegExp[] {
	return [...ACCOUNT_RESTRICTION_PATTERNS];
}
