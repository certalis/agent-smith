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
			"claude-code": {
				enabled: true,
				pool: {
					members: ["seat-a", "seat-b", "seat-preferred"],
				},
			},
			"second-claude": {
				enabled: true,
				strategy: "claude-code",
				pool: {
					members: ["seat-a", "seat-b", "seat-preferred"],
				},
			},
			anthropic: {
				pool: {
					members: ["seat-a", "seat-b", "seat-preferred"],
				},
			},
			openai: {
				pool: {
					members: ["seat-a", "seat-b", "seat-preferred"],
				},
			},
			codex: {
				pool: {
					members: ["seat-a", "seat-b", "seat-preferred"],
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
		{ name: "first", provider: "claude-code", accountUuid: "seat-a" },
		{
			name: "second-preferred",
			provider: "second-claude",
			accountUuid: "seat-preferred",
			priority: 0,
			rateLimitedFor: "1m",
		},
		{
			name: "second",
			provider: "second-claude",
			accountUuid: "seat-b",
			priority: 1,
		},
	],
	upstream: [
		{ account: "second", status: 200, json: { ok: true } },
		{ account: "second-preferred", status: 200, json: { ok: true } },
	],
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
		{ type: "advance", by: "2m" },
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
			id: "seat-pin-and-provider-preference-survive-independently",
			type: "upstream",
			accounts: ["second", "second", "second-preferred"],
		},
	],
});
