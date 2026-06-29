/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */

import {
	type Content,
	FinishReason,
	FunctionCallingConfigMode,
	type GoogleSearch,
	type Part,
	type ToolConfig,
	type ToolType,
} from "@google/genai";
import type {
	Context,
	ImageContent,
	Model,
	NativeWebSearchOptions,
	ServerToolUse,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { transformMessages } from "./transform-messages.ts";

type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 */
export function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// Check if message is from same provider and model - only then keep thinking blocks
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					// Skip empty text blocks
					if (!block.text || block.text.trim() === "") continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// Skip empty thinking blocks
					if (!block.thinking || block.thinking.trim() === "") continue;
					// Only keep as thinking block if same provider AND same model
					// Otherwise convert to plain text (no tags to avoid model mimicking them)
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(thoughtSignature && { thoughtSignature }),
					};
					parts.push(part);
				} else if (block.type === "serverToolUse") {
					// Provider-executed built-in tool (e.g. google_search). These records are
					// Gemini-internal and only meaningful when replayed to the same model, where
					// tool-context-circulation requires the call/response parts (with their thought
					// signatures) on every subsequent turn. Drop them for other providers/models.
					if (!isSameProviderAndModel) continue;
					const callSignature = resolveThoughtSignature(true, block.callSignature);
					const responseSignature = resolveThoughtSignature(true, block.responseSignature);
					const toolType = block.toolType as ToolType | undefined;
					if (block.id || toolType || block.args || callSignature) {
						parts.push({
							toolCall: {
								...(block.id ? { id: block.id } : {}),
								...(toolType ? { toolType } : {}),
								args: block.args ?? {},
							},
							...(callSignature && { thoughtSignature: callSignature }),
						});
					}
					parts.push({
						toolResponse: {
							...(block.id ? { id: block.id } : {}),
							...(toolType ? { toolType } : {}),
							response: block.response ?? {},
						},
						...(responseSignature && { thoughtSignature: responseSignature }),
					});
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ models support multimodal function responses with images nested inside
			// functionResponse.parts. Claude and other non-Gemini models behind Cloud Code Assist /
			// Gemini < 3 still needs a separate user image turn.
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// Use "output" key for success, "error" key for errors as per SDK documentation
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API requires all function responses to be in a single user turn.
			// Check if the last content is already a user turn with function responses and merge.
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// For Gemini < 3, add images in a separate user message
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions", // pre-draft-2019-09 equivalent of $defs
]);

/**
 * Strip meta-declarations from a schema obj
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, const, etc.). Set `useParameters` to true to use the legacy `parameters`
 * field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude
 * models, where the API translates `parameters` into Anthropic's `input_schema`.
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				...(useParameters
					? { parameters: sanitizeForOpenApi(tool.parameters as unknown) }
					: { parametersJsonSchema: tool.parameters }),
			})),
		},
	];
}

/**
 * Convert pi's NativeWebSearchOptions into a Gemini { googleSearch } tool entry.
 *
 * Gemini's grounding tool is `googleSearch` (Gemini 2.x+). The legacy
 * `googleSearchRetrieval` is for Gemini 1.5 only and is not handled here since
 * the registered models are all 2.x+.
 *
 * Mapping notes:
 * - `blockedDomains` → `excludeDomains` (Vertex only; ignored by Gemini API).
 * - `allowedDomains` has no Gemini equivalent — throws if provided.
 * - `maxUses`, `searchContextSize`, `userLocation` are not supported by Gemini
 *   and are silently ignored.
 */
export function convertGoogleSearchTool(
	webSearch: boolean | NativeWebSearchOptions | undefined,
): { googleSearch: GoogleSearch } | undefined {
	if (!webSearch) return undefined;
	const config: NativeWebSearchOptions = webSearch === true ? {} : webSearch;

	if (config.allowedDomains?.length) {
		throw new Error(
			"Gemini google_search does not support allowedDomains. Use blockedDomains (Vertex only) or omit.",
		);
	}

	const googleSearch: GoogleSearch = {};
	if (config.blockedDomains?.length) {
		googleSearch.excludeDomains = config.blockedDomains;
	}
	return { googleSearch };
}

/**
 * Apply a streamed server-side built-in tool part (Gemini `toolCall` / `toolResponse`)
 * to the assistant content array. Call and response parts are paired into a single
 * `ServerToolUse` block (by id when present, otherwise the most recent block awaiting a
 * response) so the pair can be replayed verbatim on later turns. Returns true when the
 * part was a server-side tool part and has been consumed.
 *
 * See https://ai.google.dev/gemini-api/docs/tool-combination — these parts, and their
 * thought signatures, must be circulated back on every subsequent turn or the API errors.
 */
export function applyServerToolPart(
	content: (TextContent | ThinkingContent | ToolCall | ServerToolUse)[],
	part: Pick<Part, "toolCall" | "toolResponse" | "thoughtSignature">,
): boolean {
	if (part.toolCall) {
		content.push({
			type: "serverToolUse",
			...(part.toolCall.id && { id: part.toolCall.id }),
			...(part.toolCall.toolType && { toolType: String(part.toolCall.toolType) }),
			...(part.toolCall.args && { args: part.toolCall.args as Record<string, any> }),
			...(part.thoughtSignature && { callSignature: part.thoughtSignature }),
		});
		return true;
	}
	if (part.toolResponse) {
		const id = part.toolResponse.id;
		let block: ServerToolUse | undefined;
		for (let i = content.length - 1; i >= 0; i--) {
			const candidate = content[i];
			if (candidate.type === "serverToolUse" && candidate.response === undefined && (!id || candidate.id === id)) {
				block = candidate;
				break;
			}
		}
		if (!block) {
			block = { type: "serverToolUse", ...(id ? { id } : {}) };
			content.push(block);
		}
		if (part.toolResponse.toolType && !block.toolType) block.toolType = String(part.toolResponse.toolType);
		if (part.toolResponse.response) block.response = part.toolResponse.response as Record<string, any>;
		if (part.thoughtSignature) block.responseSignature = part.thoughtSignature;
		return true;
	}
	return false;
}

/**
 * Build the Gemini `toolConfig`. When a server-side built-in tool (e.g. google_search) is
 * combined with client function declarations, Google requires
 * `includeServerSideToolInvocations: true`; in that mode AUTO function calling is
 * unsupported, so we default to VALIDATED while honoring an explicit none/any toolChoice.
 *
 * Returns undefined when neither a function-calling mode nor server-side circulation is
 * needed, matching the previous behavior of leaving `toolConfig` unset.
 *
 * See https://ai.google.dev/gemini-api/docs/tool-combination.
 */
export function buildGoogleToolConfig(opts: {
	hasFunctionTools: boolean;
	hasBuiltInTool: boolean;
	toolChoice?: string;
}): ToolConfig | undefined {
	const { hasFunctionTools, hasBuiltInTool, toolChoice } = opts;
	const includeServerSide = hasBuiltInTool;

	const functionCallingConfig: { mode?: FunctionCallingConfigMode } = {};
	if (hasFunctionTools) {
		const explicit = toolChoice ? mapToolChoice(toolChoice) : undefined;
		if (includeServerSide) {
			// AUTO is rejected when server-side tool circulation is enabled; VALIDATED is the
			// documented default. Preserve an explicit NONE/ANY choice.
			functionCallingConfig.mode =
				explicit === undefined || explicit === FunctionCallingConfigMode.AUTO
					? FunctionCallingConfigMode.VALIDATED
					: explicit;
		} else if (explicit !== undefined) {
			functionCallingConfig.mode = explicit;
		}
	}

	const hasMode = functionCallingConfig.mode !== undefined;
	if (!includeServerSide && !hasMode) return undefined;

	return {
		...(hasMode && { functionCallingConfig }),
		...(includeServerSide && { includeServerSideToolInvocations: true }),
	};
}

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}
