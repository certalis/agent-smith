import { defineScenario } from "./harness/scenario";

const body =
	'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"persist my choice"}]}' as const;
const changedOpening =
	'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"different opening"}]}' as const;
const path = "/v1/pool/anthropic-messages/v1/messages";

export default defineScenario({
	name: "a chosen provider and its seat survive a server restart",
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
		{ name: "first", provider: "claude-code", accountUuid: "seat-a" },
		{ name: "second", provider: "second-claude", accountUuid: "seat-b" },
	],
	upstream: [{ account: "second", status: 200, json: { ok: true } }],
	steps: [
		{
			type: "request",
			id: "choose",
			path,
			body,
			sessionId: "restart-choice",
			headers: {
				"x-agent-smith-interactive-provider-choice": "v1",
				"x-agent-smith-provider-choice": "second-claude",
			},
		},
		{ type: "restart" },
		{ type: "request", id: "resume", path, body, sessionId: "restart-choice" },
		{
			type: "request",
			id: "new-opening",
			path,
			body: changedOpening,
			sessionId: "restart-choice",
		},
	],
	assertions: [
		{ id: "all-turns-succeed", type: "client", statuses: [200, 200, 200] },
		{
			id: "same-seat-and-provider-even-with-a-different-opening",
			type: "upstream",
			accounts: ["second", "second", "second"],
		},
	],
});
