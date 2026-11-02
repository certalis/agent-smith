import { defineScenario } from "./harness/scenario";

const body = (opening: string) =>
	JSON.stringify({
		model: "claude-opus-4-5",
		messages: [{ role: "user", content: opening }],
	});

export default defineScenario({
	name: "disabling distribution drains existing conversation pins and changes only new conversations",
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
			admission_cap: 5,
		},
	},
	environment: { CF_ADMIN_KEY: "scenario-admin-key" },
	fleet: [
		{ name: "a", accountUuid: "acct-a" },
		{ name: "b", accountUuid: "acct-b" },
	],
	upstream: [
		{ account: "a", path: "/v1/messages", status: 200, json: { ok: true } },
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", body: body("first"), sessionId: "first-session" },
		{ type: "request", body: body("second"), sessionId: "second-session" },
		{
			type: "request",
			path: "/api/config/team-routing",
			headers: { "x-api-key": "scenario-admin-key" },
			body: JSON.stringify({
				enabled: true,
				distribution_enabled: false,
				allowlisted_account_uuids: ["acct-a", "acct-b"],
				admission_cap: 5,
			}),
		},
		{ type: "request", body: body("second"), sessionId: "second-session" },
		{ type: "request", body: body("third"), sessionId: "third-session" },
	],
	assertions: [
		{
			id: "existing-pin-stays-while-new-conversation-uses-normal-order",
			type: "upstream",
			accounts: ["a", "b", "b", "a"],
		},
		{
			id: "distribution-update-succeeds",
			type: "client",
			index: 2,
			status: 200,
		},
	],
	upstreamTest: "teamclaude/test/session-distribution.test.js",
});
