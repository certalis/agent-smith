import { defineScenario } from "./harness/scenario";

const body =
	'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"manual pin"}]}' as const;

export default defineScenario({
	name: "manual seat pins work on the first and selected second provider of a pool",
	config: {
		providers: {
			"claude-code": { enabled: true },
			"second-claude": { enabled: true, strategy: "claude-code" },
		},
		provider_pools: { "anthropic-messages": ["claude-code", "second-claude"] },
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["seat-a", "seat-b"],
		},
	},
	fleet: [
		{ name: "first-seat", provider: "claude-code", accountUuid: "seat-a" },
		{ name: "second-seat", provider: "second-claude", accountUuid: "seat-b" },
	],
	upstream: [
		{ account: "first-seat", status: 200, json: { ok: true } },
		{ account: "second-seat", status: 200, json: { ok: true } },
	],
	steps: [
		{
			type: "request",
			id: "first",
			path: "/tc-acct/first-seat/v1/pool/anthropic-messages/v1/messages",
			body,
		},
		{
			type: "request",
			id: "second",
			path: "/tc-acct/second-seat/v1/pool/anthropic-messages/v1/messages",
			body,
			headers: {
				"x-agent-smith-interactive-provider-choice": "v1",
				"x-agent-smith-provider-choice": "second-claude",
			},
		},
	],
	assertions: [
		{
			id: "both-manual-requests-succeed",
			type: "client",
			statuses: [200, 200],
		},
		{
			id: "each-request-reaches-the-named-seat",
			type: "upstream",
			accounts: ["first-seat", "second-seat"],
		},
	],
});
