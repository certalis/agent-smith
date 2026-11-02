import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

export default defineScenario({
	name: "a pool uses an eligible provider sibling before another provider after a 529",
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
		{ name: "claude-a", provider: "claude-code" },
		{ name: "claude-b", provider: "claude-code" },
		{ name: "acme", provider: "acme", authMethod: "api_key" },
	],
	upstream: [
		{
			account: "claude-a",
			path: "/v1/messages",
			status: 529,
			json: { type: "error" },
		},
		{
			account: "claude-b",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
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
			id: "first-provider-sibling-is-the-single-retry",
			type: "upstream",
			accounts: ["claude-a", "claude-b"],
			bodyIdentical: [body, body],
		},
		{ id: "sibling-response-reaches-client", type: "client", status: 200 },
	],
});
