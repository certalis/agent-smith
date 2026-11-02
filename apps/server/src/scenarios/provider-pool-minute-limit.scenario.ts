import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

export default defineScenario({
	name: "a per-minute limit never leaves its current provider pool member",
	config: {
		providers: {
			"claude-code": { enabled: true },
			acme: { enabled: true, strategy: "anthropic-api" },
		},
		provider_pools: {
			"anthropic-messages": ["claude-code", "acme"],
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
			status: 429,
			headers: { "retry-after": "120" },
			json: { error: { type: "rate_limit_error" } },
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
			id: "only-claude-is-contacted",
			type: "upstream",
			accounts: ["claude"],
			bodyIdentical: body,
		},
		{ id: "client-keeps-rate-limit", type: "client", status: 429 },
	],
});
