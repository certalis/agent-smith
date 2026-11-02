import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const fiveHours = 5 * 60 * 60 * 1_000;

export default defineScenario({
	name: "a pooled seat at ninety percent never serves another request",
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
			max_usage: 0.9,
		},
	},
	fleet: [
		{
			name: "a",
			accountUuid: "acct-a",
			quotaState: {
				windows: {
					unified5h: {
						resetAt: now + fiveHours,
						seenAt: now,
						status: "active",
						utilization: 0.9,
					},
				},
			},
		},
		{
			name: "b",
			accountUuid: "acct-b",
			quotaState: {
				windows: {
					unified5h: {
						resetAt: now + fiveHours,
						seenAt: now,
						status: "active",
						utilization: 0.2,
					},
				},
			},
		},
	],
	upstream: [
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{
			type: "request",
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "keep the owner reserve" }],
			}),
			sessionId: "owner-cap",
		},
	],
	assertions: [
		{ id: "cap-skips-account-a", type: "upstream", accounts: ["b"] },
	],
	upstreamTest: "teamclaude/test/account-max-usage.test.js",
});
