import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

export default defineScenario({
	name: "a caller without fallback policy stays on its provider after a 529",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
			},
			acme: {
				enabled: true,
				strategy: "anthropic-api",
			},
		},
		routing: {
			routes: {
				"anthropic-messages": ["claude-code", "acme"],
			},
			api_key_accounts: "everyone",
			callers: {},
			hold_seconds: 0,
		},
	},
	fleet: [
		{ name: "claude", provider: "claude-code" },
		{ name: "acme", provider: "acme", authMethod: "api_key" },
	],
	upstream: [
		{
			account: "claude",
			path: "/v1/messages",
			status: 529,
			json: { type: "error" },
		},
	],
	steps: [
		{
			type: "request",
			path: "/v1/pool/anthropic-messages/v1/messages",
			body,
		},
	],
	assertions: [
		{
			id: "never-retries-the-next-provider",
			type: "upstream",
			accounts: ["claude"],
			bodyIdentical: body,
		},
		{ id: "provider-error-reaches-client", type: "client", status: 529 },
	],
});
