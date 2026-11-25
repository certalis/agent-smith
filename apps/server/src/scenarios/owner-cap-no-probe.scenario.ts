import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const quota = {
	windows: {
		unified5h: {
			resetAt: now + 60 * 60 * 1_000,
			seenAt: now,
			status: "active",
			utilization: 0.9,
		},
	},
};

export default defineScenario({
	name: "the pooled ninety-percent cap also blocks all-spent revalidation",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["acct-a", "acct-b"],
					max_usage: 0.9,
					block_when_all_full: false,
				},
			},
			anthropic: {
				pool: {
					members: ["acct-a", "acct-b"],
					max_usage: 0.9,
					block_when_all_full: false,
				},
			},
			openai: {
				pool: {
					members: ["acct-a", "acct-b"],
					max_usage: 0.9,
					block_when_all_full: false,
				},
			},
			codex: {
				pool: {
					members: ["acct-a", "acct-b"],
					max_usage: 0.9,
					block_when_all_full: false,
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
		{ name: "a", accountUuid: "acct-a", quotaState: quota },
		{ name: "b", accountUuid: "acct-b", quotaState: quota },
	],
	upstream: [],
	steps: [
		{
			type: "request",
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "preserve owner reserve" }],
			}),
			sessionId: "cap-probe",
		},
	],
	assertions: [
		{ id: "cap-has-no-probe-exception", type: "upstream", count: 0 },
		{ id: "cap-returns-nearest-reset", type: "client", status: 429 },
	],
	upstreamTest: "teamclaude/test/account-max-usage.test.js",
});
