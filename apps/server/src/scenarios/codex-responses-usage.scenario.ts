import { defineScenario } from "./harness/scenario";

const body = '{"model":"gpt-5.6-sol","input":[],"stream":true}' as const;
const created =
	'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n' as const;
const completed =
	'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":13,"input_tokens_details":{"cached_tokens":5},"output_tokens":3}}}\n\n' as const;

export default defineScenario({
	name: "a successful Codex Responses stream stays chunk-for-chunk native",
	fleet: [{ name: "codex-a", provider: "codex" }],
	upstream: [
		{
			account: "codex-a",
			path: "/responses",
			status: 200,
			sse: [{ body: created }, { body: completed, afterClientChunk: true }],
		},
	],
	steps: [
		{
			type: "request",
			path: "/v1/codex/responses",
			body,
		},
	],
	assertions: [
		{
			id: "codex-responses-request-is-native",
			type: "upstream",
			count: 1,
			accounts: ["codex-a"],
			bodyIdentical: body,
		},
		{
			id: "codex-responses-client-keeps-every-chunk",
			type: "client",
			status: 200,
			body: `${created}${completed}`,
			chunks: [created, completed],
			header: { name: "content-type", value: "text/event-stream" },
		},
	],
	upstreamTest: "teamclaude/test/responses-usage.test.js",
});
