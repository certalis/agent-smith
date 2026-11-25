import { defineScenario } from "./harness/scenario";

const routing = "/api/config/providers/claude-code/pool";
const proxy = { "x-api-key": "scenario-proxy-key" };
const admin = { "x-api-key": "scenario-admin-key" };
const body = '{"model":"claude-opus-4-5","messages":[]}';

export default defineScenario({
	name: "weekly cap email overrides stay private and survive ordinary admin updates",
	environment: {
		AGENT_SMITH_TRUST_LOOPBACK: "false",
		AGENT_SMITH_PROXY_KEY: "scenario-proxy-key",
		AGENT_SMITH_ADMIN_KEY: "scenario-admin-key",
	},
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["tech"],
					weekly_max_usage_by_email: {
						"tech@example.test": 0.3,
					},
				},
			},
			anthropic: {
				pool: {
					members: ["tech"],
					weekly_max_usage_by_email: {
						"tech@example.test": 0.3,
					},
				},
			},
			openai: {
				pool: {
					members: ["tech"],
					weekly_max_usage_by_email: {
						"tech@example.test": 0.3,
					},
				},
			},
			codex: {
				pool: {
					members: ["tech"],
					weekly_max_usage_by_email: {
						"tech@example.test": 0.3,
					},
				},
			},
		},
		routing: {
			routes: {},
			api_key_accounts: "chooser_or_fallback",
			callers: {},
			hold_seconds: 0,
		},
	},
	fleet: [
		{
			name: "tech",
			accountUuid: "tech",
			enrollmentContact: { email: "tech@example.test" },
			quotaState: {
				windows: {
					unified7d: {
						resetAt: 1_700_003_600_000,
						seenAt: 1_700_000_000_000,
						status: "allowed",
						utilization: 0.3,
					},
				},
			},
		},
	],
	upstream: [
		{ account: "tech", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{
			type: "request",
			id: "read",
			method: "GET",
			path: routing,
			headers: proxy,
			body: "",
		},
		{
			type: "request",
			method: "POST",
			path: routing,
			headers: proxy,
			body: '{"weekly_max_usage_by_email":{}}',
		},
		{
			type: "request",
			method: "POST",
			path: routing,
			headers: admin,
			body: '{"enabled":false}',
		},
		{
			type: "request",
			method: "POST",
			path: routing,
			headers: admin,
			body: '{"enabled":true,"members":["tech"]}',
		},
		{ type: "request", headers: proxy, body },
		{
			type: "request",
			method: "POST",
			path: routing,
			headers: admin,
			body: '{"enabled":true,"members":["tech"],"weekly_max_usage_by_email":{}}',
		},
		{ type: "request", headers: proxy, body },
	],
	assertions: [
		{
			id: "email-policy-is-private",
			type: "client",
			request: "read",
			bodyExcludes: ["tech@example.test"],
		},
		{
			id: "only-admin-may-clear-the-preserved-policy",
			type: "client",
			statuses: [200, 401, 200, 200, 429, 200, 200],
		},
		{
			id: "only-the-explicit-clear-unblocks-the-account",
			type: "upstream",
			accounts: ["tech"],
			count: 1,
		},
	],
});
