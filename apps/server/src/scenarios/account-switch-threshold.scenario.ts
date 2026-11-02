import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;
const nearlySpent = {
	windows: {
		unified7d: {
			resetAt: 1_700_000_360_000,
			seenAt: 1_700_000_000_000,
			status: "allowed",
			utilization: 0.99,
		},
	},
} as const;

export default defineScenario({
	name: "an account-specific quota threshold overrides the fleet threshold",
	fleet: [
		{ name: "fleet-threshold", quotaState: nearlySpent },
		{
			name: "account-override",
			priority: 10,
			switchThreshold: 1,
			quotaState: nearlySpent,
		},
	],
	upstream: [
		{
			account: "account-override",
			path: "/v1/messages",
			status: 200,
			json: {},
		},
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "account-threshold-overrides-the-fleet-threshold",
			type: "upstream",
			count: 1,
			accounts: ["account-override"],
			bodyIdentical: body,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/per-account-threshold.test.js",
});
