import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;
const path = "/v1/pool/anthropic-messages/v1/messages";
const interactive = { "x-agent-smith-interactive-provider-choice": "v1" };

export default defineScenario({
	name: "a listed provider can block after the chooser selects it and releases admission",
	config: {
		providers: {
			"qwen-claude": {
				enabled: true,
				strategy: "model-studio-anthropic-api",
				pool: {
					members: [],
					admission: {
						cap: 1,
						queue_limit: 0,
					},
				},
			},
			"kimi-claude": {
				enabled: true,
				strategy: "model-studio-anthropic-api",
				pool: {
					members: [],
					admission: {
						cap: 1,
						queue_limit: 0,
					},
				},
			},
			anthropic: {
				pool: {
					members: [],
					admission: {
						cap: 1,
						queue_limit: 0,
					},
				},
			},
			openai: {
				pool: {
					members: [],
					admission: {
						cap: 1,
						queue_limit: 0,
					},
				},
			},
			"claude-code": {
				pool: {
					members: [],
					admission: {
						cap: 1,
						queue_limit: 0,
					},
				},
			},
			codex: {
				pool: {
					members: [],
					admission: {
						cap: 1,
						queue_limit: 0,
					},
				},
			},
		},
		routing: {
			routes: {
				"anthropic-messages": ["qwen-claude", "kimi-claude"],
			},
			api_key_accounts: "chooser_or_fallback",
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
			status: 429,
			json: { code: "Throttling.AllocationQuota" },
		},
		{
			account: "kimi",
			status: 429,
			times: 1,
			headers: { "retry-after": "1" },
			json: { code: "Throttling.AllocationQuota" },
		},
		{ account: "kimi", status: 200, json: { ok: true } },
	],
	steps: [
		{
			type: "request",
			id: "chooser",
			path,
			body,
			headers: interactive,
			sessionId: "choice",
		},
		{
			type: "request",
			id: "chosen-blocks",
			path,
			body,
			headers: {
				...interactive,
				"x-agent-smith-provider-choice": "kimi-claude",
			},
			sessionId: "choice",
		},
		{ type: "advance", by: "2m" },
		{
			type: "request",
			id: "next-request",
			path,
			body,
			headers: {
				...interactive,
				"x-agent-smith-provider-choice": "kimi-claude",
			},
			sessionId: "fresh",
		},
	],
	assertions: [
		{
			id: "chooser-offers-kimi",
			type: "client",
			request: "chooser",
			status: 429,
			bodyIncludes: '"provider":"kimi-claude"',
		},
		{
			id: "chosen-provider-reports-capacity",
			type: "client",
			request: "chosen-blocks",
			status: 429,
			header: { name: "content-type", value: "application/problem+json" },
		},
		{
			id: "capacity-problem-identifies-selected-provider",
			type: "client",
			request: "chosen-blocks",
			jsonPath: { path: "blockedProvider", value: "kimi-claude" },
		},
		{
			id: "capacity-problem-gives-category",
			type: "client",
			request: "chosen-blocks",
			jsonPath: { path: "category", value: "token-allocation" },
		},
		{
			id: "next-request-can-enter-with-zero-queue",
			type: "client",
			request: "next-request",
			status: 200,
		},
		{
			id: "one-send-per-turn",
			type: "upstream",
			accounts: ["qwen", "kimi", "kimi"],
		},
	],
});
