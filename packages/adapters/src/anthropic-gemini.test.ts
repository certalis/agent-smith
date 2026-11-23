import { describe, expect, it } from "bun:test";
import {
	fromGeminiGenerateContent,
	toGeminiGenerateContent,
	UnsupportedAnthropicFeatureError,
} from "./anthropic-gemini";

describe("toGeminiGenerateContent", () => {
	it("maps a supported Messages request into Gemini contents and an SSE endpoint", () => {
		const converted = toGeminiGenerateContent(
			{
				model: "claude-sonnet-4-5",
				system: "Answer with weather only.",
				max_tokens: 512,
				temperature: 0.25,
				top_p: 0.8,
				stop_sequences: ["END"],
				stream: true,
				tools: [
					{
						name: "weather",
						description: "Looks up a city's weather.",
						input_schema: {
							type: "object",
							properties: { city: { type: "string" } },
							required: ["city"],
						},
					},
				],
				messages: [
					{ role: "user", content: "What is the weather in Paris?" },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "I will check." },
							{
								type: "tool_use",
								id: "toolu_01",
								name: "weather",
								input: { city: "Paris" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "toolu_01",
								content: "Sunny",
							},
						],
					},
				],
			},
			"gemini-2.5-flash",
		);

		expect(converted).toEqual({
			body: {
				contents: [
					{
						role: "user",
						parts: [{ text: "What is the weather in Paris?" }],
					},
					{
						role: "model",
						parts: [
							{ text: "I will check." },
							{
								functionCall: {
									id: "toolu_01",
									name: "weather",
									args: { city: "Paris" },
								},
							},
						],
					},
					{
						role: "user",
						parts: [
							{
								functionResponse: {
									id: "toolu_01",
									name: "weather",
									response: { content: "Sunny" },
								},
							},
						],
					},
				],
				systemInstruction: {
					parts: [{ text: "Answer with weather only." }],
				},
				generationConfig: {
					maxOutputTokens: 512,
					temperature: 0.25,
					topP: 0.8,
					stopSequences: ["END"],
				},
				tools: [
					{
						functionDeclarations: [
							{
								name: "weather",
								description: "Looks up a city's weather.",
								parametersJsonSchema: {
									type: "object",
									properties: { city: { type: "string" } },
									required: ["city"],
								},
							},
						],
					},
				],
			},
			query: "?alt=sse",
			upstreamPath: "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
		});
	});

	it("maps a named Anthropic tool choice to Gemini's allowed function list", () => {
		const converted = toGeminiGenerateContent(
			{
				model: "claude-sonnet-4-5",
				max_tokens: 32,
				tool_choice: { type: "tool", name: "weather" },
				messages: [{ role: "user", content: "Look up Paris weather" }],
			},
			"gemini-2.5-flash",
		);

		expect(converted.body).toMatchObject({
			toolConfig: {
				functionCallingConfig: {
					mode: "ANY",
					allowedFunctionNames: ["weather"],
				},
			},
		});
	});

	it("rejects image content instead of dropping it", () => {
		expect(() =>
			toGeminiGenerateContent(
				{
					model: "claude-sonnet-4-5",
					max_tokens: 64,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "image",
									source: { type: "base64", data: "abc" },
								},
							],
						},
					],
				},
				"gemini-2.5-flash",
			),
		).toThrow(UnsupportedAnthropicFeatureError);
	});

	it.each([
		[
			"thinking",
			{
				thinking: { type: "enabled", budget_tokens: 1024 },
				messages: [{ role: "user", content: "Hello" }],
			},
		],
		[
			"cached content",
			{
				system: [
					{
						type: "text",
						text: "Remember this.",
						cache_control: { type: "ephemeral" },
					},
				],
				messages: [{ role: "user", content: "Hello" }],
			},
		],
	])("rejects unsupported %s instead of dropping it", (feature, partial) => {
		expect(() =>
			toGeminiGenerateContent(
				{
					model: "claude-sonnet-4-5",
					max_tokens: 64,
					...partial,
				},
				"gemini-2.5-flash",
			),
		).toThrow(`Gemini adapter does not support Anthropic ${feature}`);
	});

	it.each([
		["metadata", { metadata: { user_id: "user_123" } }],
		["context_management", { context_management: {} }],
		["output_config", { output_config: { format: { type: "json_object" } } }],
		["stream_options", { stream_options: { include_usage: true } }],
	])("rejects unsupported top-level %s instead of dropping it", (feature, partial) => {
		expect(() =>
			toGeminiGenerateContent(
				{
					model: "claude-sonnet-4-5",
					max_tokens: 64,
					messages: [{ role: "user", content: "Hello" }],
					...partial,
				},
				"gemini-2.5-flash",
			),
		).toThrow(`Gemini adapter does not support Anthropic ${feature}`);
	});
});

describe("fromGeminiGenerateContent", () => {
	it("maps a Gemini candidate, usage, and function call into a Messages response", async () => {
		const converted = await fromGeminiGenerateContent(
			new Response(
				JSON.stringify({
					candidates: [
						{
							content: {
								role: "model",
								parts: [
									{ text: "I found it." },
									{
										functionCall: {
											id: "call_01",
											name: "weather",
											args: { city: "Paris" },
										},
									},
								],
							},
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 11,
						candidatesTokenCount: 7,
						totalTokenCount: 18,
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
			{ messageId: "msg_google_01", model: "gemini-2.5-flash" },
		);

		expect(converted.status).toBe(200);
		expect(converted.headers.get("content-type")).toContain("application/json");
		expect(await converted.json()).toEqual({
			id: "msg_google_01",
			type: "message",
			role: "assistant",
			model: "gemini-2.5-flash",
			content: [
				{ type: "text", text: "I found it." },
				{
					type: "tool_use",
					id: "call_01",
					name: "weather",
					input: { city: "Paris" },
				},
			],
			stop_reason: "tool_use",
			stop_sequence: null,
			usage: {
				input_tokens: 11,
				output_tokens: 7,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		});
	});

	it("leaves Google error responses untouched for capacity classification", async () => {
		const upstream = new Response(
			JSON.stringify({ code: "RESOURCE_EXHAUSTED", message: "Try later" }),
			{
				status: 429,
				headers: { "retry-after": "8", "content-type": "application/json" },
			},
		);

		expect(
			await fromGeminiGenerateContent(upstream, {
				messageId: "msg_google_01",
				model: "gemini-2.5-flash",
			}),
		).toBe(upstream);
	});

	it("converts Gemini SSE text chunks into one ordered Anthropic event stream", async () => {
		const source = [
			'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello "}]}}]}\n\n',
			'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n',
		].join("");
		const converted = await fromGeminiGenerateContent(
			new Response(source, {
				headers: { "content-type": "text/event-stream" },
			}),
			{ messageId: "msg_google_02", model: "gemini-2.5-flash" },
		);

		expect(converted.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		expect(await converted.text()).toBe(
			[
				'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_google_02","type":"message","role":"assistant","content":[],"model":"gemini-2.5-flash","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n\n',
				'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
				'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
				'event: message_stop\ndata: {"type":"message_stop"}\n\n',
			].join(""),
		);
	});

	it("converts a streamed Gemini function call into an Anthropic tool-use block", async () => {
		const converted = await fromGeminiGenerateContent(
			new Response(
				'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"call_02","name":"weather","args":{"city":"Paris"}}}]},"finishReason":"STOP"}]}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			),
			{ messageId: "msg_google_03", model: "gemini-2.5-flash" },
		);

		expect(await converted.text()).toBe(
			[
				'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_google_03","type":"message","role":"assistant","content":[],"model":"gemini-2.5-flash","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n\n',
				'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_02","name":"weather","input":{}}}\n\n',
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Paris\\"}"}}\n\n',
				'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":0}}\n\n',
				'event: message_stop\ndata: {"type":"message_stop"}\n\n',
			].join(""),
		);
	});
});
