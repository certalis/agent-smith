import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "a manual Claude account pin selects one eligible pooled seat",
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
		},
	},
	fleet: [
		{ name: "a", accountUuid: "acct-a" },
		{ name: "b", accountUuid: "acct-b" },
	],
	upstream: [
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{
			type: "request",
			path: "/tc-acct/b/v1/claude-code/v1/messages",
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "debug on b" }],
			}),
			sessionId: "manual-pin",
		},
	],
	assertions: [
		{ id: "manual-pin-succeeds", type: "client", status: 200 },
		{ id: "manual-pin-reaches-account-b", type: "upstream", accounts: ["b"] },
	],
	upstreamTest: "teamclaude/test/account-pin.test.js",
});
