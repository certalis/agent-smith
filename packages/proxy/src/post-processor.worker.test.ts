import { describe, expect, it } from "bun:test";
import {
	buildRequestEndPayload,
	createRequestState,
	processStreamChunk,
} from "./post-processor.worker";
import type { StartMessage } from "./worker-messages";

function encodeBase64(text: string): string {
	return Buffer.from(text, "utf-8").toString("base64");
}

function createStartMessage(): StartMessage {
	return {
		type: "start",
		requestId: "req-1",
		accountId: "account-1",
		method: "POST",
		path: "/v1/openai/responses",
		upstreamPath: "/responses",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		responseStatus: 200,
		responseHeaders: {
			"content-type": "text/event-stream; charset=utf-8",
		},
		isStream: true,
		providerName: "openai",
		retryAttempt: 0,
		failoverAttempts: 0,
	};
}

describe("buildRequestEndPayload", () => {
	it("reads response linkage from the bodies, then stores neither body", () => {
		const startMessage: StartMessage = {
			...createStartMessage(),
			isStream: false,
			requestHeaders: { "x-claude-code-session-id": "session-123" },
			requestBody: encodeBase64(
				JSON.stringify({
					model: "gpt-5.4",
					previous_response_id: "resp_prev_456",
					input: "a private prompt",
				}),
			),
			responseHeaders: { "content-type": "application/json" },
		};
		const state = createRequestState(startMessage);

		const payload = buildRequestEndPayload({
			startMessage,
			state,
			success: true,
			responseBody: encodeBase64(
				JSON.stringify({ id: "resp_789", output_text: "a private answer" }),
			),
			timings: {
				ttftMs: null,
				proxyOverheadMs: null,
				upstreamTtfbMs: null,
				streamingDurationMs: null,
			},
		});

		expect(payload.request.body).toBeNull();
		expect(payload.response?.body).toBeNull();
		expect(payload.meta.trace).toMatchObject({
			responseId: "resp_789",
			previousResponseId: "resp_prev_456",
			clientSessionId: "session-123",
		});
		expect(payload.meta.transport.success).toBe(true);
	});
});

describe("processStreamChunk", () => {
	it("extracts usage when response.completed event and data are in the same chunk", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					"event: response.completed",
					'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-4o","usage":{"input_tokens":13,"output_tokens":5,"total_tokens":18}}}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-4o",
			inputTokens: 13,
			outputTokens: 5,
			totalTokens: 18,
		});
	});

	it("extracts usage when response.completed event and data are split across chunks", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode("event: response.completed\n"),
			state,
		);
		processStreamChunk(
			new TextEncoder().encode(
				'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-4o","usage":{"input_tokens":13,"output_tokens":5,"total_tokens":18}}}\n\n',
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-4o",
			inputTokens: 13,
			outputTokens: 5,
			totalTokens: 18,
		});
	});

	it("adjusts cached input tokens and stores reasoning tokens from response.completed usage", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					"event: response.completed",
					'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-4o","usage":{"input_tokens":18815,"output_tokens":431,"total_tokens":19246,"input_tokens_details":{"cached_tokens":18688},"output_tokens_details":{"reasoning_tokens":321}}}}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-4o",
			inputTokens: 127,
			cacheReadInputTokens: 18688,
			outputTokens: 431,
			reasoningTokens: 321,
			totalTokens: 19246,
		});
	});

	it("extracts settled usage from incomplete and failed Responses events", () => {
		for (const type of ["response.incomplete", "response.failed"]) {
			const state = createRequestState(createStartMessage());

			processStreamChunk(
				new TextEncoder().encode(
					`data: ${JSON.stringify({
						type,
						response: {
							model: "gpt-5.6-sol",
							usage: {
								input_tokens: 13,
								input_tokens_details: { cached_tokens: 5 },
								output_tokens: 3,
							},
						},
					})}\n\n`,
				),
				state,
			);

			expect(state.usage).toMatchObject({
				model: "gpt-5.6-sol",
				inputTokens: 8,
				cacheReadInputTokens: 5,
				outputTokens: 3,
			});
		}
	});

	it("tracks token timing and local token counts for response.output_text.delta events", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					"event: response.output_text.delta",
					'data: {"type":"response.output_text.delta","delta":"Hello"}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.firstTokenTimestamp).toBeNumber();
		expect(state.lastTokenTimestamp).toBeNumber();
		expect((state.usage.outputTokensComputed ?? 0) > 0).toBe(true);
	});

	it("extracts usage from chat completion chunks without explicit event lines", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					'data: {"object":"chat.completion.chunk","model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"Hey"}}]}',
					"",
					'data: {"object":"chat.completion.chunk","model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":68,"input_tokens":44,"output_tokens":24,"cache_read_input_tokens":0,"reasoning_tokens":0}}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-5.4",
			inputTokens: 44,
			outputTokens: 24,
			totalTokens: 68,
		});
		expect(state.firstTokenTimestamp).toBeNumber();
		expect(state.lastTokenTimestamp).toBeNumber();
	});
});
