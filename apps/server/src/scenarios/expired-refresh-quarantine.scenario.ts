import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}';

export default defineScenario({
	name: "an initially expired rejected refresh is quarantined across requests and restart",
	claudeOAuth: true,
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["acct-a", "acct-b"],
				},
			},
			anthropic: {
				pool: {
					members: ["acct-a", "acct-b"],
				},
			},
			openai: {
				pool: {
					members: ["acct-a", "acct-b"],
				},
			},
			codex: {
				pool: {
					members: ["acct-a", "acct-b"],
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
		{ name: "a", accountUuid: "acct-a", tokenExpiresIn: "0ms" },
		{ name: "b", accountUuid: "acct-b", priority: 1 },
	],
	upstream: [
		{
			path: "/v1/oauth/token",
			status: 400,
			json: {
				error: "invalid_grant",
				error_description: "Invalid refresh token",
			},
		},
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", body, sessionId: "expired-refresh" },
		{
			type: "request",
			id: "capacity",
			method: "GET",
			path: "/api/pool-status?provider=claude-code",
			body: "",
		},
		{ type: "restart" },
		{
			type: "request",
			id: "restarted-capacity",
			method: "GET",
			path: "/api/pool-status?provider=claude-code",
			body: "",
		},
		{ type: "request", body, sessionId: "expired-refresh" },
	],
	assertions: [
		{
			id: "failed-refresh-is-not-retried-after-restart",
			type: "upstream",
			onPath: "/v1/oauth/token",
			count: 1,
		},
		{
			id: "healthy-seat-serves-both",
			type: "upstream",
			onPath: "/v1/messages",
			accounts: ["b", "b"],
			bodyIdentical: body,
		},
		{
			id: "known-dead-refresh-is-not-capacity",
			type: "client",
			request: "capacity",
			jsonPath: { path: "eligibleAccounts", value: 1 },
		},
		{
			id: "quarantine-is-durable",
			type: "client",
			request: "restarted-capacity",
			jsonPath: { path: "eligibleAccounts", value: 1 },
		},
		{
			id: "both-conversation-requests-succeed",
			type: "client",
			statuses: [200, 200, 200, 200],
		},
	],
});
