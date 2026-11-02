import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;

export default defineScenario({
	name: "an upstream 529 takes one bounded failover hop",
	fleet: [{ name: "a" }, { name: "b" }, { name: "c" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 529,
			json: { type: "error" },
		},
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "one-hop-only",
			type: "upstream",
			count: 2,
			accounts: ["a", "b"],
			bodyIdentical: [body, body],
		},
		{ id: "sibling-response-reaches-client", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/stream-failure-failover.test.js",
});
