import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;

export default defineScenario({
	name: "a fresh shared quota window at the threshold is skipped",
	fleet: [
		{
			name: "spent",
			quotaState: {
				windows: {
					unified5h: {
						resetAt: 1_700_000_360_000,
						seenAt: 1_700_000_000_000,
						status: "allowed",
						utilization: 0.98,
					},
				},
			},
		},
		{ name: "available" },
	],
	upstream: [
		{ account: "available", path: "/v1/messages", status: 200, json: {} },
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "threshold-account-is-not-spent",
			type: "upstream",
			count: 1,
			accounts: ["available"],
			bodyIdentical: body,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/per-bucket-threshold.test.js",
});
