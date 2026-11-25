import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

export default defineScenario({
	name: "a caller without fallback policy stays on an exhausted provider",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
			},
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
				"anthropic-messages": ["claude-code", "acme"],
			},
			api_key_accounts: "everyone",
			callers: {},
			hold_seconds: 0,
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
	upstream: [],
	steps: [
		{
			type: "request",
			path: "/v1/pool/anthropic-messages/v1/messages",
			body,
		},
	],
	assertions: [
		{
			id: "never-sends-the-blocked-call-to-acme",
			type: "upstream",
			accounts: [],
		},
		{ id: "caller-receives-a-capacity-response", type: "client", status: 429 },
	],
});
