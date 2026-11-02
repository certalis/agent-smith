import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

export default defineScenario({
	name: "a pool uses the next provider for a 529 only when the first provider has no sibling",
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
			status: 529,
			json: { type: "error" },
		},
		{ account: "acme", path: "/v1/messages", status: 200, json: { ok: true } },
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
			id: "next-provider-is-the-single-retry",
			type: "upstream",
			accounts: ["claude", "acme"],
			bodyIdentical: [body, body],
		},
		{ id: "provider-retry-reaches-client", type: "client", status: 200 },
	],
});
