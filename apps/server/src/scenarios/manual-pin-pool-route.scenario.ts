import { defineScenario } from "./harness/scenario";

const body =
	'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"manual pin"}]}' as const;

export default defineScenario({
	name: "manual seat pins work on the first and selected second provider of a pool",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["seat-a", "seat-b", "decoy-a", "decoy-b"],
				},
			},
			"second-claude": {
				enabled: true,
				strategy: "claude-code",
				pool: {
					members: ["seat-a", "seat-b", "decoy-a", "decoy-b"],
				},
			},
			anthropic: {
				pool: {
					members: ["seat-a", "seat-b", "decoy-a", "decoy-b"],
				},
			},
			openai: {
				pool: {
					members: ["seat-a", "seat-b", "decoy-a", "decoy-b"],
				},
			},
			codex: {
				pool: {
					members: ["seat-a", "seat-b", "decoy-a", "decoy-b"],
				},
			},
		},
		routing: {
			routes: {
				"anthropic-messages": ["claude-code", "second-claude"],
			},
			api_key_accounts: "chooser_or_fallback",
			callers: {},
			hold_seconds: 0,
		},
	},
	fleet: [
		{ name: "first-decoy", provider: "claude-code", accountUuid: "decoy-a" },
		{ name: "first-seat", provider: "claude-code", accountUuid: "seat-a" },
		{ name: "second-decoy", provider: "second-claude", accountUuid: "decoy-b" },
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
			id: "second-without-choice",
			path: "/tc-acct/second-seat/v1/pool/anthropic-messages/v1/messages",
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
			id: "manual-pin-without-a-provider-choice-does-not-walk-the-pool",
			type: "client",
			statuses: [200, 503, 200],
		},
		{
			id: "each-request-reaches-the-named-seat",
			type: "upstream",
			accounts: ["first-seat", "second-seat"],
		},
	],
});
