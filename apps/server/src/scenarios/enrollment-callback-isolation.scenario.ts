import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "private enrollment cannot bypass email and confirmation through a legacy callback after restart",
	claudeOAuth: true,
	environment: {
		AGENT_SMITH_ADMIN_KEY: "scenario-admin-key",
		AGENT_SMITH_PROXY_KEY: "scenario-proxy-key",
		AGENT_SMITH_TRUST_LOOPBACK: "false",
		AGENT_SMITH_ENROLLMENT_ORIGIN: "https://pool.example.test",
	},
	config: { team_routing: { enabled: false } },
	fleet: [],
	upstream: [
		{
			path: "/v1/oauth/token",
			status: 200,
			json: {
				access_token: "synthetic-access",
				refresh_token: "synthetic-refresh",
				expires_in: 3600,
			},
		},
		{
			path: "/api/oauth/profile",
			status: 200,
			json: {
				account: { uuid: "synthetic-seat", email: "actual@example.test" },
				organization: { uuid: "synthetic-org" },
			},
		},
	],
	steps: [
		{
			type: "request",
			path: "/api/enrollment-invitations",
			headers: { "x-api-key": "scenario-admin-key" },
			body: '{"name":"invited-seat","email":"expected@example.test"}',
			capture: { invite: { field: "url", fragment: true } },
		},
		{
			type: "request",
			path: "/pool-enroll/start",
			headers: {
				host: "pool.example.test",
				origin: "https://pool.example.test",
			},
			body: '{"token":"{{invite}}"}',
			capture: { state: { field: "authUrl", query: "state" } },
		},
		{
			type: "request",
			id: "beforeRestart",
			method: "GET",
			path: "/oauth/claude-code/callback?state={{state}}&code=synthetic-code%23{{state}}",
			headers: { "x-api-key": "scenario-proxy-key" },
			body: "",
		},
		{ type: "restart" },
		{
			type: "request",
			id: "afterRestart",
			method: "GET",
			path: "/oauth/claude-code/callback?state={{state}}&code=synthetic-code%23{{state}}",
			headers: { "x-api-key": "scenario-proxy-key" },
			body: "",
		},
		{
			type: "request",
			id: "accounts",
			method: "GET",
			path: "/api/accounts",
			headers: { "x-api-key": "scenario-proxy-key" },
			body: "",
		},
	],
	assertions: [
		{
			id: "callback-rejects-live-invitation-session",
			type: "client",
			request: "beforeRestart",
			status: 400,
		},
		{
			id: "callback-rejects-restarted-invitation-session",
			type: "client",
			request: "afterRestart",
			status: 400,
		},
		{
			id: "callback-cannot-create-account",
			type: "client",
			request: "accounts",
			body: "[]",
		},
		{ id: "callback-never-exchanges-code", type: "upstream", count: 0 },
	],
});
