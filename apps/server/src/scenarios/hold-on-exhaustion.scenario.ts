import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;

export default defineScenario({
	name: "a pooled request waits for a near quota reset instead of receiving a 429",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["acct-a"],
				},
			},
			anthropic: {
				pool: {
					members: ["acct-a"],
				},
			},
			openai: {
				pool: {
					members: ["acct-a"],
				},
			},
			codex: {
				pool: {
					members: ["acct-a"],
				},
			},
		},
		routing: {
			routes: {},
			api_key_accounts: "chooser_or_fallback",
			callers: {},
			hold_seconds: 2,
		},
	},
	fleet: [
		{
			name: "a",
			accountUuid: "acct-a",
			quotaState: {
				windows: {
					unified5h: {
						resetAt: now + 1_000,
						seenAt: now,
						status: "rejected",
						utilization: 1,
					},
				},
			},
		},
	],
	upstream: [
		{ account: "a", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{
			type: "request",
			id: "held",
			waitForCompletion: false,
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "wait for reset" }],
			}),
			sessionId: "quota-hold",
		},
		{ type: "flush" },
		{ type: "advance", by: "1s" },
		{ type: "await", id: "held" },
	],
	assertions: [
		{
			id: "held-request-retries-after-reset",
			type: "upstream",
			accounts: ["a"],
		},
		{ id: "held-client-succeeds", type: "client", statuses: [200] },
	],
	upstreamTest: "teamclaude/test/session-starved.test.js",
});
