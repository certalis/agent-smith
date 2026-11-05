import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-opus-4-5","messages":[]}' as const;
const slackPath = "/api/chat.postMessage";
const spentWindow = (resetAt: number) => ({
	windows: {
		unified5h: {
			resetAt,
			seenAt: 1_700_000_000_000,
			status: "allowed",
			utilization: 0.99,
		},
	},
});

export default defineScenario({
	name: "a full fleet refuses every request by default and alerts once",
	config: {
		alerts: { slack_bot_token: "xoxb-scenario", slack_channel: "C0SCENARIO" },
	},
	fleet: [
		{ name: "a", quotaState: spentWindow(1_700_000_060_000) },
		{ name: "b", quotaState: spentWindow(1_700_000_120_000) },
		{ name: "paused-with-quota", paused: true },
	],
	upstream: [
		{ path: "/v1/messages", status: 200, json: { ok: true } },
		{ path: slackPath, status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", body, count: 2 },
		{ type: "wait-for-upstream", count: 1 },
	],
	assertions: [
		{
			id: "no-revalidation-probe-spends-extra-usage",
			type: "upstream",
			onPath: "/v1/messages",
			count: 0,
		},
		{
			id: "every-client-waits-for-the-soonest-reset",
			type: "client",
			statuses: [429, 429],
		},
		{
			id: "the-refusal-names-the-soonest-reset",
			type: "client",
			index: 0,
			header: { name: "retry-after", value: "60" },
		},
		{
			id: "slack-hears-once-that-the-fleet-is-full",
			type: "upstream",
			onPath: slackPath,
			count: 1,
			header: { name: "authorization", value: "Bearer xoxb-scenario" },
			bodyIncludes: [
				'"channel":"C0SCENARIO"',
				"account is out of quota until 2023-11-14 22:14 UTC. Requests are refused until then.",
			],
		},
	],
});
