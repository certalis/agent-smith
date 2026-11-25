import { defineScenario } from "./harness/scenario";
import { standaloneRequest, standaloneWire } from "./harness/wire-fixture";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

export default defineScenario({
	...standaloneWire,
	name: "an ordered-fallback caller uses the next provider for a 529 when the first provider has no sibling",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["claude-seat"],
				},
			},
			acme: {
				enabled: true,
				strategy: "anthropic-api",
				pool: {
					members: ["claude-seat"],
				},
			},
			anthropic: {
				pool: {
					members: ["claude-seat"],
				},
			},
			openai: {
				pool: {
					members: ["claude-seat"],
				},
			},
			codex: {
				pool: {
					members: ["claude-seat"],
				},
			},
		},
		routing: {
			routes: {
				"anthropic-messages": ["claude-code", "acme"],
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
		{
			name: "claude",
			provider: "claude-code",
			authMethod: "oauth",
			accountUuid: "claude-seat",
		},
		{
			name: "acme",
			provider: "acme",
			authMethod: "api_key",
		},
	],
	upstream: [
		{
			account: "claude",
			path: "/v1/messages",
			status: 529,
			json: { type: "error" },
		},
		{ account: "acme", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{
			...standaloneRequest,
			body,
		},
	],
	assertions: [
		{
			id: "ordered-policy-allows-the-single-provider-retry",
			type: "upstream",
			accounts: ["claude", "acme"],
			bodyIdentical: [body, body],
		},
		{ id: "provider-retry-reaches-client", type: "client", status: 200 },
	],
});
