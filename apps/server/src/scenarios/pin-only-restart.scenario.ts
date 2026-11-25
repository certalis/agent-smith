import { defineScenario } from "./harness/scenario";
import { standaloneRequest, standaloneWire } from "./harness/wire-fixture";

const body =
	'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"persist my seat"}]}' as const;

export default defineScenario({
	...standaloneWire,
	name: "a second-provider seat pin without a chooser preference survives restart",
	config: {
		providers: {
			"claude-code": { enabled: true },
			"second-claude": { enabled: true, strategy: "claude-code" },
		},
		provider_pools: { "anthropic-messages": ["claude-code", "second-claude"] },
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["seat-a", "seat-b"],
			caller_provider_fallback: { "synthetic-device": "ordered" },
		},
	},
	fleet: [
		{ name: "first", provider: "claude-code", accountUuid: "seat-a" },
		{ name: "second", provider: "second-claude", accountUuid: "seat-b" },
	],
	upstream: [
		{ account: "first", status: 529, times: 1, json: { type: "error" } },
		{ account: "first", status: 200, json: { ok: true } },
		{ account: "second", status: 200, json: { ok: true } },
	],
	steps: [
		{ ...standaloneRequest, id: "fallback", body, sessionId: "restart-pin" },
		{ type: "restart" },
		{ ...standaloneRequest, id: "resume", body, sessionId: "restart-pin" },
	],
	assertions: [
		{ id: "both-turns-succeed", type: "client", statuses: [200, 200] },
		{
			id: "after-restart-pin-skips-first",
			type: "upstream",
			accounts: ["first", "second", "second"],
		},
	],
});
