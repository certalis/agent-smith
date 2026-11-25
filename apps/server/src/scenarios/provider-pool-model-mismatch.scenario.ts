import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "a pool names its config key when no provider serves a requested model",
	config: {
		providers: {
			acme: {
				enabled: true,
				strategy: "anthropic-api",
				models: {
					"claude-sonnet-*": "acme-sonnet",
				},
			},
		},
		routing: {
			routes: {
				"anthropic-messages": ["acme"],
			},
			api_key_accounts: "everyone",
			callers: {},
			hold_seconds: 0,
		},
	},
	fleet: [{ name: "acme", provider: "acme", authMethod: "api_key" }],
	upstream: [],
	steps: [
		{
			type: "request",
			path: "/v1/pool/anthropic-messages/v1/messages",
			body: '{"model":"claude-opus-4-5","messages":[]}',
		},
	],
	assertions: [
		{
			id: "model-error-names-pool-config",
			type: "client",
			status: 400,
			bodyIncludes: "provider_pools.anthropic-messages",
		},
	],
});
