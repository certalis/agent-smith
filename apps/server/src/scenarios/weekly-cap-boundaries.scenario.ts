import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const window = (utilization: number) => ({
	resetAt: now + 3_600_000,
	seenAt: now,
	status: "allowed",
	utilization,
});
const seat = (name: string, weekly: number, fiveHour: number) => ({
	name,
	accountUuid: name,
	enrollmentContact: { email: `${name}@example.test` },
	quotaState: {
		windows: { unified7d: window(weekly), unified5h: window(fiveHour) },
	},
});
const capped = (account: string, utilization: string) => ({
	account,
	path: "/v1/messages",
	status: 200,
	json: { ok: true },
	headers: {
		"anthropic-ratelimit-unified-7d-status": "allowed",
		"anthropic-ratelimit-unified-7d-utilization": utilization,
		"anthropic-ratelimit-unified-7d-reset": String((now + 3_600_000) / 1_000),
	},
});

export default defineScenario({
	name: "weekly cap admits below 95% or the email cap and leaves the five-hour cap unchanged",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["normal", "tech", "five-hour"],
					weekly_max_usage_by_email: {
						" Tech@Example.test ": 0.3,
					},
				},
			},
			anthropic: {
				pool: {
					members: ["normal", "tech", "five-hour"],
					weekly_max_usage_by_email: {
						" Tech@Example.test ": 0.3,
					},
				},
			},
			openai: {
				pool: {
					members: ["normal", "tech", "five-hour"],
					weekly_max_usage_by_email: {
						" Tech@Example.test ": 0.3,
					},
				},
			},
			codex: {
				pool: {
					members: ["normal", "tech", "five-hour"],
					weekly_max_usage_by_email: {
						" Tech@Example.test ": 0.3,
					},
				},
			},
		},
		routing: {
			routes: {},
			api_key_accounts: "chooser_or_fallback",
			callers: {},
			hold_seconds: 0,
		},
	},
	fleet: [
		seat("normal", 0.949, 0.1),
		seat("tech", 0.299, 0.2),
		seat("five-hour", 0, 0.9),
	],
	upstream: [capped("normal", "0.95"), capped("tech", "0.3")],
	steps: [0, 1, 2].map((index) => ({
		type: "request",
		sessionId: `weekly-${index}`,
		body: JSON.stringify({
			model: "claude-opus-4-5",
			messages: [{ role: "user", content: `topic ${index}` }],
		}),
	})),
	assertions: [
		{
			id: "each-seat-stops-at-its-weekly-cap",
			type: "upstream",
			accounts: ["normal", "tech"],
			count: 2,
		},
		{
			id: "five-hour-reserve-cannot-serve-the-exhausted-pool",
			type: "client",
			statuses: [200, 200, 429],
		},
	],
});
