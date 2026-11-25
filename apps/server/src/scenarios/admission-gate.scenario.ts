import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "one full pooled account queues the next request until its slot is released",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["acct-a"],
					admission: {
						cap: 1,
						queue_limit: 1,
						wait_ms: 1000,
					},
				},
			},
			anthropic: {
				pool: {
					members: ["acct-a"],
					admission: {
						cap: 1,
						queue_limit: 1,
						wait_ms: 1000,
					},
				},
			},
			openai: {
				pool: {
					members: ["acct-a"],
					admission: {
						cap: 1,
						queue_limit: 1,
						wait_ms: 1000,
					},
				},
			},
			codex: {
				pool: {
					members: ["acct-a"],
					admission: {
						cap: 1,
						queue_limit: 1,
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
	fleet: [{ name: "a", accountUuid: "acct-a" }],
	upstream: [
		{
			id: "first-response",
			account: "a",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
			times: 1,
			hold: { received: 1, release: "manual" },
		},
		{ account: "a", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{
			type: "request",
			id: "first",
			waitForCompletion: false,
			waitForUpstream: 1,
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "first" }],
			}),
			sessionId: "admission-first",
		},
		{
			type: "request",
			id: "second",
			waitForCompletion: false,
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "second" }],
			}),
			sessionId: "admission-second",
		},
		{ type: "flush" },
		{ type: "release", id: "first-response" },
		{ type: "await", id: "first" },
		{ type: "await", id: "second" },
	],
	assertions: [
		{
			id: "second-request-waits-for-first-slot",
			type: "upstream",
			count: 2,
			neverWhileHold: "first-response",
		},
		{ id: "both-clients-succeed", type: "client", statuses: [200, 200] },
	],
	upstreamTest: "teamclaude/test/admission-gate.test.js",
});
