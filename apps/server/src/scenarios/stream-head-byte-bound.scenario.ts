import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","stream":true,"messages":[]}' as const;
const boundedHead = "x".repeat(256 * 1024);
const overloadPastBound =
	'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n' as const;
const oversizedChunk = `${boundedHead}${overloadPastBound}`;

export default defineScenario({
	name: "a 256 KiB SSE head ignores an overload past its bound in one chunk",
	fleet: [{ name: "a" }, { name: "b" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 200,
			sse: [{ body: oversizedChunk }],
		},
		{
			account: "b",
			path: "/v1/messages",
			status: 200,
			sse: [{ body: "event: message_start\n\n" }],
		},
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "only-the-first-account-is-contacted-after-the-head-bound",
			type: "upstream",
			count: 1,
			accounts: ["a"],
			bodyIdentical: body,
		},
		{
			id: "client-receives-the-original-oversized-chunk-after-the-head-bound",
			type: "client",
			status: 200,
			body: oversizedChunk,
		},
	],
	upstreamTest: "teamclaude/test/sse-parse-bounds.test.js",
});
