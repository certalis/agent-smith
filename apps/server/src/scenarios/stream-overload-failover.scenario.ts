import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","stream":true,"messages":[]}' as const;
const overloaded =
	'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n' as const;
const messageStart =
	'event: message_start\ndata: {"type":"message_start"}\n\n' as const;
const messageStop =
	'event: message_stop\ndata: {"type":"message_stop"}\n\n' as const;

export default defineScenario({
	name: "an overload in the head of an SSE reply takes one failover hop",
	fleet: [{ name: "a" }, { name: "b" }, { name: "c" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 200,
			sse: [{ body: overloaded }],
		},
		{
			account: "b",
			path: "/v1/messages",
			status: 200,
			sse: [{ body: messageStart }, { body: messageStop }],
		},
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "one-sibling-retries-after-stream-overload",
			type: "upstream",
			count: 2,
			accounts: ["a", "b"],
			bodyIdentical: [body, body],
		},
		{
			id: "client-gets-only-the-sibling-stream",
			type: "client",
			status: 200,
			body: `${messageStart}${messageStop}`,
		},
	],
	upstreamTest: "teamclaude/test/stream-failure-failover.test.js",
});
