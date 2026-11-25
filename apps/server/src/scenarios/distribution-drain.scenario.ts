import { defineScenario } from "./harness/scenario";

const body = (opening: string) =>
	JSON.stringify({
		model: "claude-opus-4-5",
		messages: [{ role: "user", content: opening }],
	});

export default defineScenario({
	name: "disabling distribution drains existing conversation pins and changes only new conversations",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 5,
					},
				},
			},
			anthropic: {
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 5,
					},
				},
			},
			openai: {
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 5,
					},
				},
			},
			codex: {
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 5,
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
	environment: { AGENT_SMITH_ADMIN_KEY: "scenario-admin-key" },
	fleet: [
		{ name: "a", accountUuid: "acct-a" },
		{ name: "b", accountUuid: "acct-b" },
	],
	upstream: [
		{ account: "a", path: "/v1/messages", status: 200, json: { ok: true } },
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", body: body("first"), sessionId: "first-session" },
		{ type: "request", body: body("second"), sessionId: "second-session" },
		{
			type: "request",
			path: "/api/config/providers/claude-code/pool",
			headers: { "x-api-key": "scenario-admin-key" },
			body: JSON.stringify({
				enabled: true,
				distribution_enabled: false,
				members: ["acct-a", "acct-b"],
				admission: { cap: 5 },
			}),
		},
		{ type: "request", body: body("second"), sessionId: "second-session" },
		{ type: "request", body: body("third"), sessionId: "third-session" },
	],
	assertions: [
		{
			id: "existing-pin-stays-while-new-conversation-uses-normal-order",
			type: "upstream",
			accounts: ["a", "b", "b", "a"],
		},
		{
			id: "distribution-update-succeeds",
			type: "client",
			index: 2,
			status: 200,
		},
	],
	upstreamTest: "teamclaude/test/session-distribution.test.js",
});
