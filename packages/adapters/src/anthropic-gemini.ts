type JsonRecord = Record<string, unknown>;

const UNSUPPORTED_REQUEST_FIELDS = [
	"container",
	"context_management",
	"inference_geo",
	"mcp_servers",
	"metadata",
	"output_config",
	"service_tier",
	"stream_options",
] as const;

type GeminiPart =
	| { text: string }
	| { functionCall: { args: JsonRecord; id: string; name: string } }
	| {
			functionResponse: {
				id: string;
				name: string;
				response: JsonRecord;
			};
	  };

type GeminiContent = {
	role: "model" | "user";
	parts: GeminiPart[];
};

export type GeminiGenerateContentRequest = {
	body: JsonRecord;
	query: string;
	upstreamPath: string;
};

export type GeminiResponseContext = {
	messageId: string;
	model: string;
};

export class UnsupportedAnthropicFeatureError extends Error {
	constructor(feature: string) {
		super(`Gemini adapter does not support Anthropic ${feature}`);
		this.name = "UnsupportedAnthropicFeatureError";
	}
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
	if (!isRecord(value))
		throw new TypeError(`Expected ${label} to be an object`);
	return value;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string")
		throw new TypeError(`Expected ${label} to be a string`);
	return value;
}

function rejectUnsupportedRequestFields(request: JsonRecord): void {
	for (const field of UNSUPPORTED_REQUEST_FIELDS) {
		if (request[field] !== undefined) {
			throw new UnsupportedAnthropicFeatureError(field);
		}
	}
}

function contentParts(
	value: unknown,
	role: string,
	toolNames: Map<string, string> = new Map(),
): GeminiPart[] {
	if (typeof value === "string") return [{ text: value }];
	if (!Array.isArray(value)) {
		throw new TypeError(
			`Expected ${role} message content to be a string or array`,
		);
	}

	return value.map((entry) => {
		const block = record(entry, `${role} content block`);
		if (block.cache_control !== undefined) {
			throw new UnsupportedAnthropicFeatureError("cached content");
		}
		switch (block.type) {
			case "text":
				return { text: string(block.text, "text block.text") };
			case "tool_use": {
				const id = string(block.id, "tool_use.id");
				const name = string(block.name, "tool_use.name");
				toolNames.set(id, name);
				return {
					functionCall: {
						id,
						name,
						args: record(block.input, "tool_use.input"),
					},
				};
			}
			case "tool_result": {
				const result = block.content;
				if (typeof result !== "string") {
					throw new UnsupportedAnthropicFeatureError(
						"non-text tool_result content",
					);
				}
				const id = string(block.tool_use_id, "tool_result.tool_use_id");
				const name = toolNames.get(id);
				if (!name) {
					throw new UnsupportedAnthropicFeatureError(
						"tool_result without a preceding tool_use",
					);
				}
				return {
					functionResponse: {
						id,
						name,
						response: { content: result },
					},
				};
			}
			default:
				throw new UnsupportedAnthropicFeatureError(
					typeof block.type === "string" ? `${block.type} content` : "content",
				);
		}
	});
}

function systemInstruction(value: unknown): JsonRecord | undefined {
	if (value === undefined) return undefined;
	const parts = contentParts(value, "system");
	if (parts.some((part) => !Object.hasOwn(part, "text"))) {
		throw new UnsupportedAnthropicFeatureError("non-text system content");
	}
	return { parts };
}

function generationConfig(input: JsonRecord): JsonRecord | undefined {
	const config: JsonRecord = {};
	if (typeof input.max_tokens === "number") {
		config.maxOutputTokens = input.max_tokens;
	}
	if (typeof input.temperature === "number")
		config.temperature = input.temperature;
	if (typeof input.top_p === "number") config.topP = input.top_p;
	if (typeof input.top_k === "number") config.topK = input.top_k;
	if (Array.isArray(input.stop_sequences)) {
		config.stopSequences = input.stop_sequences.map((entry) =>
			string(entry, "stop_sequences entry"),
		);
	}
	return Object.keys(config).length > 0 ? config : undefined;
}

function toolDeclarations(value: unknown): JsonRecord[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value))
		throw new TypeError("Expected tools to be an array");
	const declarations = value.map((entry) => {
		const tool = record(entry, "tool");
		if (tool.cache_control !== undefined) {
			throw new UnsupportedAnthropicFeatureError("cached content");
		}
		if (tool.type !== undefined && tool.type !== "custom") {
			throw new UnsupportedAnthropicFeatureError("provider-hosted tools");
		}
		const declaration: JsonRecord = {
			name: string(tool.name, "tool.name"),
			parameters: record(tool.input_schema, "tool.input_schema"),
		};
		if (tool.description !== undefined) {
			declaration.description = string(tool.description, "tool.description");
		}
		return declaration;
	});
	return declarations.length > 0
		? [{ functionDeclarations: declarations }]
		: undefined;
}

function toolConfig(value: unknown): JsonRecord | undefined {
	if (value === undefined) return undefined;
	const choice = record(value, "tool_choice");
	if (choice.disable_parallel_tool_use === true) {
		throw new UnsupportedAnthropicFeatureError("disable_parallel_tool_use");
	}
	const type = string(choice.type, "tool_choice.type");
	const functionCallingConfig: JsonRecord = {
		mode:
			type === "auto"
				? "AUTO"
				: type === "any" || type === "tool"
					? "ANY"
					: type === "none"
						? "NONE"
						: undefined,
	};
	if (functionCallingConfig.mode === undefined) {
		throw new UnsupportedAnthropicFeatureError(`tool_choice ${type}`);
	}
	if (type === "tool") {
		functionCallingConfig.allowedFunctionNames = [
			string(choice.name, "tool_choice.name"),
		];
	}
	return { functionCallingConfig };
}

function geminiModelPath(model: string, stream: boolean): string {
	if (!/^[A-Za-z0-9._-]+$/.test(model)) {
		throw new TypeError(
			"Gemini model must contain only letters, numbers, dots, underscores, and dashes",
		);
	}
	return `/v1beta/models/${model}:${stream ? "streamGenerateContent" : "generateContent"}`;
}

export function toGeminiGenerateContent(
	input: unknown,
	mappedModel: string,
): GeminiGenerateContentRequest {
	const request = record(input, "Anthropic Messages request");
	if (request.thinking !== undefined) {
		throw new UnsupportedAnthropicFeatureError("thinking");
	}
	rejectUnsupportedRequestFields(request);
	if (!Array.isArray(request.messages)) {
		throw new TypeError("Expected messages to be an array");
	}
	const toolNames = new Map<string, string>();
	const contents = request.messages.map((entry) => {
		const message = record(entry, "message");
		const role = string(message.role, "message.role");
		if (role !== "user" && role !== "assistant") {
			throw new UnsupportedAnthropicFeatureError(`${role} message role`);
		}
		return {
			role: role === "assistant" ? "model" : "user",
			parts: contentParts(message.content, role, toolNames),
		} satisfies GeminiContent;
	});

	const stream = request.stream === true;
	const body: JsonRecord = { contents };
	const system = systemInstruction(request.system);
	if (system) body.systemInstruction = system;
	const generation = generationConfig(request);
	if (generation) body.generationConfig = generation;
	const tools = toolDeclarations(request.tools);
	if (tools) body.tools = tools;
	const choice = toolConfig(request.tool_choice);
	if (choice) body.toolConfig = choice;

	return {
		body,
		query: stream ? "?alt=sse" : "",
		upstreamPath: geminiModelPath(mappedModel, stream),
	};
}

function integer(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function anthropicStopReason(
	finishReason: unknown,
	hasToolUse: boolean,
): "end_turn" | "max_tokens" | "tool_use" {
	if (hasToolUse) return "tool_use";
	return finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";
}

function sseEvent(name: string, data: JsonRecord): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function geminiSseToAnthropic(
	body: ReadableStream<Uint8Array>,
	context: GeminiResponseContext,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	let started = false;
	let activeTextIndex: number | undefined;
	let nextBlockIndex = 0;
	let hasToolUse = false;
	let finishReason: unknown;
	let outputTokens = 0;

	const write = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		event: string,
	) => controller.enqueue(encoder.encode(event));
	const ensureStarted = (
		controller: ReadableStreamDefaultController<Uint8Array>,
	) => {
		if (started) return;
		started = true;
		write(
			controller,
			sseEvent("message_start", {
				type: "message_start",
				message: {
					id: context.messageId,
					type: "message",
					role: "assistant",
					content: [],
					model: context.model,
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
				},
			}),
		);
	};
	const closeText = (
		controller: ReadableStreamDefaultController<Uint8Array>,
	) => {
		if (activeTextIndex === undefined) return;
		write(
			controller,
			sseEvent("content_block_stop", {
				type: "content_block_stop",
				index: activeTextIndex,
			}),
		);
		activeTextIndex = undefined;
	};
	const openText = (
		controller: ReadableStreamDefaultController<Uint8Array>,
	) => {
		if (activeTextIndex !== undefined) return activeTextIndex;
		const index = nextBlockIndex;
		nextBlockIndex += 1;
		activeTextIndex = index;
		write(
			controller,
			sseEvent("content_block_start", {
				type: "content_block_start",
				index,
				content_block: { type: "text", text: "" },
			}),
		);
		return index;
	};
	const emitPart = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		part: unknown,
	) => {
		const value = record(part, "Gemini streaming candidate part");
		if (typeof value.text === "string") {
			const index = openText(controller);
			write(
				controller,
				sseEvent("content_block_delta", {
					type: "content_block_delta",
					index,
					delta: { type: "text_delta", text: value.text },
				}),
			);
			return;
		}
		if (!isRecord(value.functionCall)) {
			throw new UnsupportedAnthropicFeatureError(
				"Gemini streaming candidate part",
			);
		}
		closeText(controller);
		hasToolUse = true;
		const call = value.functionCall;
		const index = nextBlockIndex;
		nextBlockIndex += 1;
		const id =
			typeof call.id === "string"
				? call.id
				: `${context.messageId}_tool_${index + 1}`;
		write(
			controller,
			sseEvent("content_block_start", {
				type: "content_block_start",
				index,
				content_block: {
					type: "tool_use",
					id,
					name: string(call.name, "Gemini functionCall.name"),
					input: {},
				},
			}),
		);
		write(
			controller,
			sseEvent("content_block_delta", {
				type: "content_block_delta",
				index,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify(
						record(call.args, "Gemini functionCall.args"),
					),
				},
			}),
		);
		write(
			controller,
			sseEvent("content_block_stop", { type: "content_block_stop", index }),
		);
	};
	const consumePayload = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		payload: unknown,
	) => {
		const data = record(payload, "Gemini stream payload");
		const candidate = Array.isArray(data.candidates)
			? data.candidates[0]
			: undefined;
		if (!candidate) return;
		const candidateRecord = record(candidate, "Gemini stream candidate");
		const content = record(
			candidateRecord.content,
			"Gemini stream candidate.content",
		);
		if (!Array.isArray(content.parts)) {
			throw new TypeError(
				"Expected Gemini stream candidate content.parts to be an array",
			);
		}
		ensureStarted(controller);
		for (const part of content.parts) emitPart(controller, part);
		finishReason = candidateRecord.finishReason ?? finishReason;
		if (isRecord(data.usageMetadata)) {
			outputTokens = integer(data.usageMetadata.candidatesTokenCount);
		}
	};
	const consumeEvent = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		event: string,
	) => {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") return;
		try {
			consumePayload(controller, JSON.parse(data));
		} catch (error) {
			if (
				error instanceof UnsupportedAnthropicFeatureError ||
				error instanceof TypeError
			) {
				throw error;
			}
			// Malformed upstream chunks must not make an already-started client stream invalid.
		}
	};

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				const reader = body.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					while (true) {
						const delimiter = buffer.search(/\r?\n\r?\n/);
						if (delimiter < 0) break;
						const event = buffer.slice(0, delimiter);
						const separator = buffer.match(/^([\s\S]*?)(\r?\n\r?\n)/)?.[2];
						buffer = buffer.slice(delimiter + (separator?.length ?? 2));
						consumeEvent(controller, event);
					}
				}
				buffer += decoder.decode();
				if (buffer.trim()) consumeEvent(controller, buffer);
				ensureStarted(controller);
				closeText(controller);
				write(
					controller,
					sseEvent("message_delta", {
						type: "message_delta",
						delta: {
							stop_reason: anthropicStopReason(finishReason, hasToolUse),
							stop_sequence: null,
						},
						usage: { output_tokens: outputTokens },
					}),
				);
				write(controller, sseEvent("message_stop", { type: "message_stop" }));
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});
}

export async function fromGeminiGenerateContent(
	response: Response,
	context: GeminiResponseContext,
): Promise<Response> {
	if (!response.ok) return response;
	if (response.headers.get("content-type")?.includes("text/event-stream")) {
		if (!response.body) {
			throw new TypeError("Expected Gemini SSE response body");
		}
		return new Response(geminiSseToAnthropic(response.body, context), {
			status: response.status,
			statusText: response.statusText,
			headers: { "content-type": "text/event-stream" },
		});
	}
	const payload = record(await response.json(), "Gemini response");
	const candidate = Array.isArray(payload.candidates)
		? payload.candidates[0]
		: undefined;
	const content = record(
		record(candidate, "Gemini candidate").content,
		"candidate.content",
	);
	if (!Array.isArray(content.parts)) {
		throw new TypeError(
			"Expected Gemini candidate content.parts to be an array",
		);
	}

	let functionCallIndex = 0;
	const blocks = content.parts.map((entry) => {
		const part = record(entry, "Gemini candidate part");
		if (typeof part.text === "string") {
			return { type: "text" as const, text: part.text };
		}
		if (isRecord(part.functionCall)) {
			functionCallIndex += 1;
			const call = part.functionCall;
			return {
				type: "tool_use" as const,
				id:
					typeof call.id === "string"
						? call.id
						: `${context.messageId}_tool_${functionCallIndex}`,
				name: string(call.name, "Gemini functionCall.name"),
				input: record(call.args, "Gemini functionCall.args"),
			};
		}
		throw new UnsupportedAnthropicFeatureError("Gemini candidate part");
	});
	const usage = isRecord(payload.usageMetadata) ? payload.usageMetadata : {};
	const message = {
		id: context.messageId,
		type: "message",
		role: "assistant",
		model: context.model,
		content: blocks,
		stop_reason: anthropicStopReason(
			record(candidate, "Gemini candidate").finishReason,
			blocks.some((block) => block.type === "tool_use"),
		),
		stop_sequence: null,
		usage: {
			input_tokens: integer(usage.promptTokenCount),
			output_tokens: integer(usage.candidatesTokenCount),
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
	};

	return new Response(JSON.stringify(message), {
		status: response.status,
		headers: { "content-type": "application/json" },
	});
}
