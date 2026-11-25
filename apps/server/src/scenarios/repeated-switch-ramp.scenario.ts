import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}';

export default defineScenario({
	name: "repeated fallback arrivals do not restart a pooled sibling admission ramp",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 3,
						queue_limit: 3,
						wait_ms: 1000,
					},
				},
			},
			anthropic: {
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 3,
						queue_limit: 3,
						wait_ms: 1000,
					},
				},
			},
			openai: {
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 3,
						queue_limit: 3,
						wait_ms: 1000,
					},
				},
			},
			codex: {
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 3,
						queue_limit: 3,
						wait_ms: 1000,
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
		{ name: "a", accountUuid: "acct-a" },
		{ name: "b", accountUuid: "acct-b", priority: 1 },
	],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 503,
			json: { error: "unavailable" },
		},
		{
			id: "first-b",
			account: "b",
			path: "/v1/messages",
			status: 200,
			json: {},
			times: 1,
			hold: { received: 1, release: "manual" },
		},
		{ account: "b", path: "/v1/messages", status: 200, json: {} },
	],
	steps: [
		{
			type: "request",
			id: "first",
			body,
			sessionId: "repeat-fallback",
			waitForCompletion: false,
			waitForUpstream: 2,
		},
		{ type: "advance", by: "250ms" },
		{
			type: "request",
			id: "second",
			body,
			sessionId: "repeat-fallback",
			waitForCompletion: false,
		},
		{ type: "wait-for-upstream", count: 4 },
		{ type: "await", id: "second" },
		{ type: "advance", by: "30s" },
		{
			type: "request",
			id: "warm-sibling",
			body,
			sessionId: "repeat-fallback",
			waitForCompletion: false,
		},
		{ type: "wait-for-upstream", count: 6 },
		{ type: "await", id: "warm-sibling" },
		{ type: "release", id: "first-b" },
		{ type: "await", id: "first" },
	],
	assertions: [
		{
			id: "second-fallback-uses-the-opened-slot",
			type: "upstream",
			count: 6,
			accounts: ["a", "b", "a", "b", "a", "b"],
		},
		{ id: "all-fallbacks-succeed", type: "client", statuses: [200, 200, 200] },
	],
});
