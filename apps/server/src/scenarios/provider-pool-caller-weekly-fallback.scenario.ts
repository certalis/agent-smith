import { defineScenario } from "./harness/scenario";
import { standaloneRequest, standaloneWire } from "./harness/wire-fixture";

const now = 1_700_000_000_000;
const oneWeek = 7 * 24 * 60 * 60 * 1_000;
const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

export default defineScenario({
	...standaloneWire,
	name: "an ordered-fallback caller skips a Claude seat at its weekly ceiling",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["claude-seat"],
					max_usage: 0.9,
					weekly_max_usage: 0.95,
					caller_weekly_max_usage: {
						"synthetic-device": 0.7,
					},
				},
			},
			acme: {
				enabled: true,
				strategy: "anthropic-api",
				pool: {
					members: ["claude-seat"],
					max_usage: 0.9,
					weekly_max_usage: 0.95,
					caller_weekly_max_usage: {
						"synthetic-device": 0.7,
					},
				},
			},
			anthropic: {
				pool: {
					members: ["claude-seat"],
					max_usage: 0.9,
					weekly_max_usage: 0.95,
					caller_weekly_max_usage: {
						"synthetic-device": 0.7,
					},
				},
			},
			openai: {
				pool: {
					members: ["claude-seat"],
					max_usage: 0.9,
					weekly_max_usage: 0.95,
					caller_weekly_max_usage: {
						"synthetic-device": 0.7,
					},
				},
			},
			codex: {
				pool: {
					members: ["claude-seat"],
					max_usage: 0.9,
					weekly_max_usage: 0.95,
					caller_weekly_max_usage: {
						"synthetic-device": 0.7,
					},
				},
			},
		},
		routing: {
			routes: {
				"anthropic-messages": ["claude-code", "acme"],
			},
			api_key_accounts: "chooser_or_fallback",
			callers: {
				"synthetic-device": {
					allow_fallbacks: true,
				},
			},
			hold_seconds: 0,
		},
	},
	fleet: [
		{
			name: "claude",
			provider: "claude-code",
			authMethod: "oauth",
			accountUuid: "claude-seat",
			quotaState: {
				windows: {
					unified7d: {
						resetAt: now + oneWeek,
						seenAt: now,
						status: "allowed",
						utilization: 0.7,
					},
				},
			},
		},
		{
			name: "acme",
			provider: "acme",
			authMethod: "api_key",
		},
	],
	upstream: [
		{ account: "acme", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [{ ...standaloneRequest, body }],
	assertions: [
		{
			id: "weekly-ceiling-skips-claude-and-sends-only-to-acme",
			type: "upstream",
			accounts: ["acme"],
			bodyIdentical: body,
		},
		{ id: "ordered-fallback-reaches-the-client", type: "client", status: 200 },
	],
});
