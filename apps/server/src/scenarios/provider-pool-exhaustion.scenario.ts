import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;
const mappedBody = '{"model":"acme-sonnet","messages":[]}' as const;

export default defineScenario({
	name: "a pool moves from an exhausted provider to a compatible mapped provider",
	config: {
		providers: {
			"claude-code": { enabled: true },
			acme: {
				enabled: true,
				strategy: "anthropic-api",
				models: { "claude-sonnet-*": "acme-sonnet" },
			},
		},
		provider_pools: {
			"anthropic-messages": ["claude-code", "acme"],
		},
	},
	fleet: [
		{
			name: "spent-claude",
			provider: "claude-code",
			quotaState: {
				windows: {
					unified5h: {
						resetAt: now + 60 * 60 * 1_000,
						seenAt: now,
						status: "rejected",
						utilization: 1,
					},
				},
			},
		},
		{ name: "acme", provider: "acme", authMethod: "api_key" },
	],
	upstream: [
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
			id: "falls-through-to-acme",
			type: "upstream",
			accounts: ["acme"],
			bodyIdentical: mappedBody,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
});
