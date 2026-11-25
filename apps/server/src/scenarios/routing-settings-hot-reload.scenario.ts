import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;
const path = "/v1/pool/anthropic-messages/v1/messages";
export default defineScenario({
	name: "route settings take effect immediately after an administrator update",
	environment: { AGENT_SMITH_ADMIN_KEY: "scenario-admin-key" },
	config: {
		providers: {
			alpha: { enabled: true, strategy: "anthropic-api" },
			beta: { enabled: true, strategy: "anthropic-api" },
		},
		routing: {
			routes: { "anthropic-messages": ["alpha"] },
			api_key_accounts: "everyone",
		},
	},
	fleet: [
		{ name: "alpha", provider: "alpha", authMethod: "api_key" },
		{ name: "beta", provider: "beta", authMethod: "api_key" },
	],
	upstream: [
		{ account: "alpha", status: 200, json: { ok: true } },
		{ account: "beta", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", id: "before", path, body },
		{
			type: "request",
			id: "update",
			path: "/api/config/routing",
			headers: { "x-api-key": "scenario-admin-key" },
			body: '{"routes":{"anthropic-messages":["beta"]},"api_key_accounts":"everyone"}',
		},
		{ type: "request", id: "after", path, body },
	],
	assertions: [
		{ id: "update-accepted", type: "client", request: "update", status: 200 },
		{
			id: "changed-route-used-on-next-request",
			type: "upstream",
			accounts: ["alpha", "beta"],
		},
		{
			id: "second-request-served",
			type: "client",
			request: "after",
			status: 200,
		},
	],
});
