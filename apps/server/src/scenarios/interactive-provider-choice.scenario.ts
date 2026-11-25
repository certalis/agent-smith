import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

export default defineScenario({
	name: "an interactive Claude provider pool asks before moving a Model Studio blocked turn",
	config: {
		providers: {
			"qwen-claude": {
				enabled: true,
				strategy: "model-studio-anthropic-api",
				models: {
					"claude-sonnet-*": "qwen3-coder-flash",
				},
			},
			"kimi-claude": {
				enabled: true,
				strategy: "model-studio-anthropic-api",
				models: {
					"claude-sonnet-*": "kimi-k3.1-pro",
				},
			},
		},
		routing: {
			routes: {
				"anthropic-messages": ["qwen-claude", "kimi-claude"],
			},
			api_key_accounts: "everyone",
			callers: {},
			hold_seconds: 0,
		},
	},
	fleet: [
		{ name: "qwen", provider: "qwen-claude", authMethod: "api_key" },
		{ name: "kimi", provider: "kimi-claude", authMethod: "api_key" },
	],
	upstream: [
		{
			account: "qwen",
			path: "/v1/messages",
			status: 429,
			headers: { "content-type": "application/json" },
			json: { code: "Throttling.AllocationQuota" },
		},
	],
	steps: [
		{
			type: "request",
			path: "/v1/pool/anthropic-messages/v1/messages",
			body,
			headers: { "x-agent-smith-interactive-provider-choice": "v1" },
		},
	],
	assertions: [
		{
			id: "does-not-send-the-turn-to-kimi-without-a-choice",
			type: "upstream",
			accounts: ["qwen"],
			headerAbsent: "x-agent-smith-interactive-provider-choice",
		},
		{ id: "client-gets-a-choice", type: "client", status: 429 },
		{
			id: "reports-the-actual-limit-category",
			type: "client",
			jsonPath: { path: "category", value: "token-allocation" },
		},
		{
			id: "offers-kimi-as-the-replacement",
			type: "client",
			bodyIncludes: '"provider":"kimi-claude"',
		},
	],
});
