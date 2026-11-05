import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const fiveHours = 5 * 60 * 60 * 1_000;

export default defineScenario({
	name: "a stale pooled ninety-percent reading stays blocked until its reset",
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
			max_usage: 0.9,
		},
	},
	fleet: [
		{
			name: "stale-at-cap",
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
		{ name: "available", accountUuid: "acct-b" },
	],
	upstream: [
		{
			account: "available",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
		},
	],
	steps: [
		{ type: "advance", by: "30m" },
		{ type: "advance", by: "1ms" },
		{
			type: "request",
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "preserve the owner reserve" }],
			}),
			sessionId: "stale-owner-cap",
		},
	],
	assertions: [
		{
			id: "stale-cap-skips-account",
			type: "upstream",
			accounts: ["available"],
		},
	],
});
