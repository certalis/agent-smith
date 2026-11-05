import { servedOnExtraUsageHeaders } from "./harness/quota-headers";
import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-opus-4-5","stream":true,"messages":[]}' as const;
const slackPath = "/services/T000/B000/scenario";

export default defineScenario({
	name: "a seat that serves a response on extra usage alerts Slack and email once it ends",
	config: {
		alerts: {
			slack_webhook_url: `https://hooks.slack.com${slackPath}`,
			email: "pool-ops@example.test",
			email_from: "agent-smith@example.test",
			resend_api_key: "re_scenario",
		},
	},
	fleet: [{ name: "over-limit" }],
	upstream: [
		{
			account: "over-limit",
			path: "/v1/messages",
			status: 200,
			headers: servedOnExtraUsageHeaders,
			sse: [
				{ body: 'event: message_start\ndata: {"type":"message_start"}\n\n' },
				{ body: 'event: message_stop\ndata: {"type":"message_stop"}\n\n' },
			],
		},
		{ path: slackPath, status: 200, json: { ok: true } },
		{ path: "/emails", status: 200, json: { id: "scenario" } },
	],
	steps: [
		{ type: "request", body },
		{ type: "wait-for-upstream", count: 3 },
	],
	assertions: [
		{
			id: "the-billed-response-reaches-the-client",
			type: "client",
			status: 200,
		},
		{
			id: "slack-hears-once-which-seat-spent-extra-usage",
			type: "upstream",
			onPath: slackPath,
			count: 1,
			bodyIncludes: [
				"over-limit",
				"was billed to extra usage",
				"The limit resets at 2023-11-15 00:13 UTC.",
			],
		},
		{
			id: "the-alert-email-goes-to-the-configured-address",
			type: "upstream",
			onPath: "/emails",
			count: 1,
			header: { name: "authorization", value: "Bearer re_scenario" },
			bodyIncludes: [
				'"to":["pool-ops@example.test"]',
				'"subject":"agent-smith: over-limit spent extra usage"',
			],
		},
	],
});
