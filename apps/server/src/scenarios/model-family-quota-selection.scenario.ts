import { defineScenario } from "./harness/scenario";

const opusBody = '{"model":"claude-opus-5","messages":[]}' as const;
const fableBody = '{"model":"claude-fable-5-1","messages":[]}' as const;

export default defineScenario({
	name: "a weekly family bucket only excludes its matching model family",
	fleet: [
		{
			name: "a",
			quotaState: {
				windows: {
					unified7d: {
						resetAt: 1_700_000_360_000,
						seenAt: 1_700_000_000_000,
						status: "allowed",
						utilization: 0.1,
					},
					unified7dFable: {
						resetAt: 1_700_000_360_000,
						seenAt: 1_700_000_000_000,
						status: "allowed",
						utilization: 0.99,
					},
				},
			},
		},
		{ name: "b" },
	],
	upstream: [
		{ account: "a", path: "/v1/messages", status: 200, json: { ok: true } },
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", body: opusBody },
		{ type: "request", body: fableBody },
	],
	assertions: [
		{
			id: "only-fable-rotates-off-the-fable-window",
			type: "upstream",
			count: 2,
			accounts: ["a", "b"],
			bodyIdentical: [opusBody, fableBody],
		},
		{ id: "both-model-requests-succeed", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/per-account-threshold.test.js",
});
