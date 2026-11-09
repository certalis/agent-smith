import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const headers = { "x-api-key": "scenario-proxy-key" };
const path = "/api/pool-status?provider=claude-code";
const window = (resetAt: number) => ({
	resetAt,
	seenAt: now,
	status: "active" as const,
	utilization: 0.9,
});
const status = (eligibleAccounts: number, retryAtMs: number | null) =>
	JSON.stringify({
		version: 1,
		provider: "claude-code",
		routingEnabled: true,
		eligibleAccounts,
		retryAtMs,
		holdSeconds: 0,
		admissionWaitMs: 1000,
	});

export default defineScenario({
	name: "pool capacity is read-only, authenticated and excludes non-routable seats",
	environment: {
		AGENT_SMITH_TRUST_LOOPBACK: "false",
		AGENT_SMITH_PROXY_KEY: "scenario-proxy-key",
		AGENT_SMITH_ADMIN_KEY: "scenario-admin-key",
	},
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: [
				"acct-a",
				"acct-b",
				"paused",
				"cooling",
				"api",
				"other",
			],
			max_usage: 0.9,
			hold_seconds: 0,
			admission_wait_ms: 1000,
		},
	},
	fleet: [
		{
			name: "a",
			accountUuid: "acct-a",
			quotaState: { windows: { unified5h: window(now + 1000) } },
		},
		{
			name: "b",
			accountUuid: "acct-b",
			quotaState: {
				windows: {
					unified5h: window(now + 2000),
					unified7dSonnet: window(now + 3000),
				},
			},
		},
		{ name: "protected", accountUuid: "protected" },
		{ name: "paused", accountUuid: "paused", paused: true },
		{ name: "cooling", accountUuid: "cooling", rateLimitedFor: "1h" },
		{ name: "api", accountUuid: "api", authMethod: "api_key" },
		{ name: "other", accountUuid: "other", provider: "openai" },
	],
	upstream: [],
	steps: [
		{ type: "request", method: "GET", path, body: "" },
		{ type: "request", method: "GET", path, headers, body: "" },
		{ type: "restart" },
		{ type: "advance", by: "1s" },
		{ type: "request", method: "GET", path, headers, body: "" },
		{ type: "advance", by: "1s" },
		{ type: "request", method: "GET", path, headers, body: "" },
		{
			type: "request",
			method: "GET",
			path: `${path}&model=claude-sonnet-4-5`,
			headers,
			body: "",
		},
		{
			type: "request",
			method: "POST",
			path: "/api/config/team-routing",
			headers,
			body: '{"enabled":false}',
		},
		{ type: "request", method: "GET", path, headers, body: "" },
	],
	assertions: [
		{ id: "read-needs-key", type: "client", index: 0, status: 401 },
		{
			id: "exhausted-pool",
			type: "client",
			index: 1,
			status: 200,
			body: status(0, now + 1000),
		},
		{
			id: "first-reset",
			type: "client",
			index: 2,
			status: 200,
			body: status(1, null),
		},
		{
			id: "second-reset",
			type: "client",
			index: 3,
			status: 200,
			body: status(2, null),
		},
		{
			id: "model-specific-cap",
			type: "client",
			index: 4,
			status: 200,
			body: status(1, null),
		},
		{ id: "proxy-key-cannot-admin", type: "client", index: 5, status: 401 },
		{
			id: "read-does-not-change-pool",
			type: "client",
			index: 6,
			status: 200,
			body: status(2, null),
		},
		{ id: "no-upstream-work", type: "upstream", count: 0 },
	],
});
