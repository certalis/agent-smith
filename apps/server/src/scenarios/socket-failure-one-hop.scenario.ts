import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;

export default defineScenario({
	name: "a connection failure takes at most one sibling hop",
	fleet: [
		{ name: "a", transportFailure: true },
		{ name: "b", transportFailure: true },
		{ name: "c" },
	],
	upstream: [
		{ account: "c", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "one-sibling-retries-after-a-real-connection-reset",
			type: "upstream",
			count: 2,
			accounts: ["a", "b"],
			bodyIdentical: [body, body],
		},
		{ id: "client-sees-gateway-error", type: "client", status: 502 },
	],
	upstreamTest: "teamclaude/test/forward-target.test.js",
});
