import { defineScenario } from "./harness/scenario";
import { standaloneRequest, standaloneWire } from "./harness/wire-fixture";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

export default defineScenario({
	...standaloneWire,
	name: "an ordered-fallback caller uses the next provider for a 529 when the first provider has no sibling",
	config: {
		providers: {
			"claude-code": { enabled: true },
			acme: { enabled: true, strategy: "anthropic-api" },
		},
		provider_pools: {
			"anthropic-messages": ["claude-code", "acme"],
		},
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["claude-seat"],
			caller_provider_fallback: { "synthetic-device": "ordered" },
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
