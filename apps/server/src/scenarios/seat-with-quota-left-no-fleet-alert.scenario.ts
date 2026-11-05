import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const slackPath = "/services/T000/B000/scenario";
const body = '{"model":"claude-opus-4-5","messages":[]}' as const;

export default defineScenario({
	name: "a full seat beside one cooling with quota left is not a full fleet",
	config: {
		alerts: { slack_webhook_url: `https://hooks.slack.com${slackPath}` },
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
		},
	},
	fleet: [
		{
			name: "a",
			accountUuid: "acct-a",
			quotaState: {
				windows: {
					unified5h: {
						resetAt: now + 60 * 60 * 1_000,
						seenAt: now,
						status: "allowed",
						utilization: 0.99,
					},
				},
			},
		},
		{ name: "b", accountUuid: "acct-b", rateLimitedFor: "30s" },
	],
	upstream: [
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
		{ path: slackPath, status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", path: "/tc-acct/a/v1/claude-code/v1/messages", body },
		{ type: "request", path: "/v1/claude-code/v1/messages", body },
		{ type: "advance", by: "31s" },
		{ type: "request", path: "/v1/claude-code/v1/messages", body },
	],
	assertions: [
		{
			id: "refused-until-the-cooling-seat-serves",
			type: "client",
			statuses: [429, 429, 200],
		},
		{
			id: "a-pin-retries-at-its-own-seat-reset",
			type: "client",
			index: 0,
			header: { name: "retry-after", value: "3600" },
		},
		{
			id: "an-unpinned-request-retries-when-the-cooldown-ends",
			type: "client",
			index: 1,
			header: { name: "retry-after", value: "31" },
		},
		{
			id: "no-fleet-full-alert",
			type: "upstream",
			onPath: slackPath,
			count: 0,
		},
	],
});
