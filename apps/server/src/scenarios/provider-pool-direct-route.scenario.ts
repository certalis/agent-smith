import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

export default defineScenario({
	name: "a direct provider route remains direct when its wire has a pool",
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
			status: 200,
			json: { ok: true },
		},
	],
	steps: [
		{
			type: "request",
			path: "/v1/claude-code/v1/messages",
			body,
		},
	],
	assertions: [
		{
			id: "direct-route-never-selects-acme",
			type: "upstream",
			accounts: ["claude"],
			bodyIdentical: body,
		},
		{ id: "direct-client-succeeds", type: "client", status: 200 },
	],
});
