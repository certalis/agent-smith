import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;
export default defineScenario({
	name: "provider pool settings take effect immediately after an administrator update",
	environment: { AGENT_SMITH_ADMIN_KEY: "scenario-admin-key" },
	config: {
		providers: { "claude-code": { enabled: true, pool: { members: ["a"] } } },
		routing: {
			routes: { "anthropic-messages": ["claude-code"] },
			api_key_accounts: "chooser_or_fallback",
		},
	},
	fleet: [
		{ name: "a", accountUuid: "a" },
		{ name: "b", accountUuid: "b" },
	],
	upstream: [
		{ account: "a", status: 200, json: { ok: true } },
		{ account: "b", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", id: "before", body, sessionId: "before" },
		{
			type: "request",
			id: "update",
			path: "/api/config/providers/claude-code/pool",
			headers: { "x-api-key": "scenario-admin-key" },
			body: '{"members":["b"]}',
		},
		{ type: "request", id: "after", body, sessionId: "after" },
	],
	assertions: [
		{ id: "update-accepted", type: "client", request: "update", status: 200 },
		{
			id: "updated-membership-controls-next-request",
			type: "upstream",
			accounts: ["a", "b"],
		},
		{
			id: "both-requests-served",
			type: "client",
			request: "after",
			status: 200,
		},
	],
});
