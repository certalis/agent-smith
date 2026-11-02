import { defineScenario } from "./harness/scenario";

const body =
	'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"stay warm"}]}' as const;

export default defineScenario({
	name: "a pooled conversation stays pinned to its eligible provider account",
	config: {
		providers: {
			"claude-code": { enabled: true },
			acme: { enabled: true, strategy: "anthropic-api" },
		},
		provider_pools: {
			"anthropic-messages": ["claude-code", "acme"],
		},
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
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
