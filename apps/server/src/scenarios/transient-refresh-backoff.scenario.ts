import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}';

export default defineScenario({
	name: "a transient refresh failure leaves routing during backoff and recovers without quarantine",
	claudeOAuth: true,
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
		},
	},
	fleet: [
		{ name: "a", accountUuid: "acct-a", tokenExpiresIn: "0ms" },
		{ name: "b", accountUuid: "acct-b", priority: 1 },
	],
	upstream: [
		{
			path: "/v1/oauth/token",
			status: 503,
			json: { error: "temporarily_unavailable" },
			times: 1,
		},
		{
			path: "/v1/oauth/token",
			status: 429,
			json: { error: "too_many_requests" },
			times: 1,
		},
		{
			path: "/v1/oauth/token",
			status: 408,
			json: { error: "request_timeout" },
			times: 1,
		},
		{
			path: "/v1/oauth/token",
			status: 200,
			json: {
				access_token: "tok-a",
				refresh_token: "refresh-a",
				expires_in: 3600,
			},
		},
		{ path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", body },
		{
			type: "request",
			id: "backoff-capacity",
			method: "GET",
			path: "/api/pool-status?provider=claude-code",
			body: "",
		},
		{ type: "request", body },
		{ type: "advance", by: "1m" },
		{
			type: "request",
			id: "recovered-capacity",
			method: "GET",
			path: "/api/pool-status?provider=claude-code",
			body: "",
		},
		{ type: "request", body },
		{
			type: "request",
			id: "limited-refresh-capacity",
			method: "GET",
			path: "/api/pool-status?provider=claude-code",
			body: "",
		},
		{ type: "advance", by: "1m" },
		{ type: "request", body },
		{
			type: "request",
			id: "timed-out-refresh-capacity",
			method: "GET",
			path: "/api/pool-status?provider=claude-code",
			body: "",
		},
		{ type: "advance", by: "1m" },
		{ type: "request", body },
	],
	assertions: [
		{
			id: "refresh-is-tried-once-per-backoff",
			type: "upstream",
			onPath: "/v1/oauth/token",
			count: 4,
		},
		{
			id: "backoff-seat-does-not-count-as-capacity",
			type: "client",
			request: "backoff-capacity",
			jsonPath: { path: "eligibleAccounts", value: 1 },
		},
		{
			id: "temporary-failure-is-not-permanent",
			type: "client",
			request: "recovered-capacity",
			jsonPath: { path: "eligibleAccounts", value: 2 },
		},
		{
			id: "refresh-rate-limit-is-temporary",
			type: "client",
			request: "limited-refresh-capacity",
			jsonPath: { path: "eligibleAccounts", value: 1 },
		},
		{
			id: "refresh-timeout-is-temporary",
			type: "client",
			request: "timed-out-refresh-capacity",
			jsonPath: { path: "eligibleAccounts", value: 1 },
		},
		{
			id: "requests-skip-backoff-then-recover",
			type: "upstream",
			onPath: "/v1/messages",
			accounts: ["b", "b", "b", "b", "a"],
			bodyIdentical: body,
		},
		{
			id: "clients-succeed",
			type: "client",
			statuses: [200, 200, 200, 200, 200, 200, 200, 200, 200],
		},
	],
});
