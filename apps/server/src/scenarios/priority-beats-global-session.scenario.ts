import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;

export default defineScenario({
	name: "an old global session does not override account priority",
	fleet: [
		{ name: "old-session", activeSession: true, priority: 10 },
		{ name: "lowest-priority", priority: 1 },
	],
	upstream: [
		{
			account: "lowest-priority",
			path: "/v1/messages",
			status: 200,
			json: {},
		},
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "priority-beats-the-legacy-global-session",
			type: "upstream",
			count: 1,
			accounts: ["lowest-priority"],
			bodyIdentical: body,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/account-routing.test.js",
});
