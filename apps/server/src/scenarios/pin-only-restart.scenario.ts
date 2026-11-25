import { defineScenario } from "./harness/scenario";
import { standaloneRequest, standaloneWire } from "./harness/wire-fixture";

const body =
	'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"persist my seat"}]}' as const;
const changedOpening =
	'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"different opening"}]}' as const;

export default defineScenario({
	...standaloneWire,
	name: "a second-provider seat pin without a chooser preference survives restart",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["seat-a", "seat-b"],
				},
			},
			"second-claude": {
				enabled: true,
				strategy: "claude-code",
				pool: {
					members: ["seat-a", "seat-b"],
				},
			},
			anthropic: {
				pool: {
					members: ["seat-a", "seat-b"],
				},
			},
			openai: {
				pool: {
					members: ["seat-a", "seat-b"],
				},
			},
			codex: {
				pool: {
					members: ["seat-a", "seat-b"],
				},
			},
		},
		routing: {
			routes: {
				"anthropic-messages": ["claude-code", "second-claude"],
			},
			api_key_accounts: "chooser_or_fallback",
			callers: {
				"synthetic-device": {
					allow_fallbacks: true,
				},
			},
			hold_seconds: 0,
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
		{
			...standaloneRequest,
			id: "new-opening",
			body: changedOpening,
			sessionId: "restart-pin",
		},
	],
	assertions: [
		{ id: "all-turns-succeed", type: "client", statuses: [200, 200, 200] },
		{
			id: "after-restart-pin-skips-first",
			type: "upstream",
			accounts: ["first", "second", "second", "first"],
		},
	],
});
