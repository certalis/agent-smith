import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;

export default defineScenario({
	name: "a new request prefers the lowest account priority",
	fleet: [
		{ name: "later", priority: 5 },
		{ name: "sooner", priority: 1 },
	],
	upstream: [
		{ account: "sooner", path: "/v1/messages", status: 200, json: {} },
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "lowest-priority-account-serves-first",
			type: "upstream",
			count: 1,
			accounts: ["sooner"],
			bodyIdentical: body,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/account-routing.test.js",
});
