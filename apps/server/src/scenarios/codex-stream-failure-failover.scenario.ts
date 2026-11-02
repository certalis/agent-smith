import { defineScenario } from "./harness/scenario";

const body = '{"model":"gpt-5.6-sol","input":[],"stream":true}' as const;
const failed =
	'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_error"}}}\n\n' as const;
const start =
	'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n' as const;
const complete =
	'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n\n' as const;

export default defineScenario({
	name: "a Codex failure inside a 200 stream takes one bounded sibling hop",
	fleet: [
		{ name: "codex-a", provider: "codex" },
		{ name: "codex-b", provider: "codex" },
		{ name: "codex-c", provider: "codex" },
	],
	upstream: [
		{
			account: "codex-a",
			path: "/responses",
			status: 200,
			sse: [{ body: failed }],
		},
		{
			account: "codex-b",
			path: "/responses",
			status: 200,
			sse: [{ body: start }, { body: complete }],
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
			id: "one-sibling-retries-after-codex-stream-failure",
			type: "upstream",
			count: 2,
			accounts: ["codex-a", "codex-b"],
			bodyIdentical: [body, body],
		},
		{
			id: "client-gets-only-the-sibling-codex-stream",
			type: "client",
			status: 200,
			body: `${start}${complete}`,
		},
	],
});
