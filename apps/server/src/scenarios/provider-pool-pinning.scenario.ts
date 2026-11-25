import { defineScenario } from "./harness/scenario";

const body =
	'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"stay warm"}]}' as const;

export default defineScenario({
	name: "a pooled conversation stays pinned to its eligible provider account",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["acct-a", "acct-b"],
				},
			},
			acme: {
				enabled: true,
				strategy: "anthropic-api",
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
			routes: {
				"anthropic-messages": ["claude-code", "acme"],
			},
			api_key_accounts: "chooser_or_fallback",
			callers: {},
			hold_seconds: 0,
		},
	},
	fleet: [
		{ name: "claude-a", provider: "claude-code", accountUuid: "acct-a" },
		{ name: "claude-b", provider: "claude-code", accountUuid: "acct-b" },
		{ name: "acme", provider: "acme", authMethod: "api_key" },
	],
	upstream: [
		{ account: "claude-a", path: "/v1/messages", status: 200, json: { ok: 1 } },
		{ account: "claude-a", path: "/v1/messages", status: 200, json: { ok: 2 } },
	],
	steps: [
		{
			type: "request",
			path: "/v1/pool/anthropic-messages/v1/messages",
			body,
			sessionId: "pool-pin",
		},
		{
			type: "request",
			path: "/v1/pool/anthropic-messages/v1/messages",
			body,
			sessionId: "pool-pin",
		},
	],
	assertions: [
		{
			id: "same-eligible-account-keeps-serving",
			type: "upstream",
			accounts: ["claude-a", "claude-a"],
			bodyIdentical: [body, body],
		},
		{
			id: "both-client-requests-succeed",
			type: "client",
			statuses: [200, 200],
		},
	],
});
