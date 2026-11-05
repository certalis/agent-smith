import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const slackPath = "/services/T000/B000/scenario";
const body = '{"model":"claude-opus-4-5","messages":[]}' as const;
const spentUntil = (resetAt: number) => ({
	windows: {
		unified5h: {
			resetAt,
			seenAt: now,
			status: "rejected" as const,
			utilization: 1,
		},
	},
});

export default defineScenario({
	name: "a pool request pinned to a full seat retries at that seat's reset and the alert names the fleet's first",
	config: {
		alerts: { slack_webhook_url: `https://hooks.slack.com${slackPath}` },
		providers: { "claude-code": { enabled: true } },
		provider_pools: { "anthropic-messages": ["claude-code"] },
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
		},
	},
	fleet: [
		{
			name: "a",
			accountUuid: "acct-a",
			quotaState: spentUntil(now + 60 * 60 * 1_000),
		},
		{
			name: "b",
			accountUuid: "acct-b",
			quotaState: spentUntil(now + 2 * 60 * 1_000),
		},
	],
	upstream: [{ path: slackPath, status: 200, json: { ok: true } }],
	steps: [
		{
			type: "request",
			path: "/tc-acct/a/v1/pool/anthropic-messages/v1/messages",
			body,
		},
		{ type: "wait-for-upstream", count: 1 },
	],
	assertions: [
		{
			id: "the-pinned-pool-request-waits-for-its-seat",
			type: "client",
			index: 0,
			status: 429,
			header: { name: "retry-after", value: "3600" },
		},
		{
			id: "the-alert-names-the-first-seat-of-the-fleet-to-serve",
			type: "upstream",
			onPath: slackPath,
			count: 1,
			bodyIncludes: [
				"Every provider_pools.anthropic-messages account is out of quota until 2023-11-14 22:15 UTC.",
			],
		},
	],
});
