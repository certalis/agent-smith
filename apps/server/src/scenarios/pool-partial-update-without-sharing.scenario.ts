import { at, defineScenario } from "./harness/scenario";

const path = "/api/config/providers/claude-code/pool";
const headers = { "x-api-key": "scenario-admin-key" };

export default defineScenario({
	name: "a partial pool update leaves sharing off and both personal accounts usable",
	environment: { AGENT_SMITH_ADMIN_KEY: "scenario-admin-key" },
	config: { providers: { "claude-code": { enabled: true } } },
	fleet: [
		{ name: "a", accountUuid: "seat-a", priority: 0 },
		{ name: "b", accountUuid: "seat-b", priority: 1 },
	],
	upstream: [
		{ account: "a", status: 200, json: { ok: true }, times: 1 },
		{
			account: "a",
			status: 429,
			headers: {
				"anthropic-ratelimit-unified-reset": at("1h"),
				"anthropic-ratelimit-unified-status": "rejected",
			},
			json: { error: { type: "rate_limit_error" }, type: "error" },
		},
		{ account: "b", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", id: "before", method: "GET", path, headers, body: "" },
		{
			type: "request",
			id: "update",
			path,
			headers,
			body: '{"window_warmup":{"enabled":true}}',
		},
		{ type: "request", id: "after", method: "GET", path, headers, body: "" },
		{
			type: "request",
			id: "account-a",
			path: "/v1/claude-code/v1/messages",
			body: '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"account a"}]}',
			sessionId: "account-a",
		},
		{
			type: "request",
			id: "account-b",
			path: "/v1/claude-code/v1/messages",
			body: '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"account b"}]}',
			sessionId: "account-b",
		},
		{ type: "request", id: "enable", path, headers, body: '{"enabled":true}' },
		{ type: "request", id: "enabled", method: "GET", path, headers, body: "" },
	],
	assertions: [
		{
			id: "initially-disabled",
			type: "client",
			request: "before",
			status: 200,
			jsonPath: { path: "enabled", value: false },
		},
		{
			id: "update-accepted-sharing-still-off",
			type: "client",
			request: "update",
			status: 200,
			jsonPath: { path: "data.enabled", value: false },
		},
		{
			id: "updated-pool-remains-off",
			type: "client",
			request: "after",
			status: 200,
			jsonPath: { path: "enabled", value: false },
		},
		{
			id: "warmup-setting-saved",
			type: "client",
			request: "after",
			jsonPath: { path: "windowWarmup.enabled", value: true },
		},
		{
			id: "account-a-serves",
			type: "client",
			request: "account-a",
			status: 200,
		},
		{
			id: "account-b-serves",
			type: "client",
			request: "account-b",
			status: 200,
		},
		{
			id: "both-accounts-reached",
			type: "upstream",
			accounts: ["a", "a", "b"],
		},
		{
			id: "explicit-enable-accepted",
			type: "client",
			request: "enable",
			status: 200,
			jsonPath: { path: "data.enabled", value: true },
		},
		{
			id: "sharing-explicitly-enabled",
			type: "client",
			request: "enabled",
			status: 200,
			jsonPath: { path: "enabled", value: true },
		},
	],
});
