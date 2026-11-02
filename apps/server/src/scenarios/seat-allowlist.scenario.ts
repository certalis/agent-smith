import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "a protected Claude seat outside the allowlist never receives pooled traffic",
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["pooled-account"],
		},
	},
	fleet: [
		{ name: "pooled", accountUuid: "pooled-account" },
		{ name: "protected", accountUuid: "protected-account" },
	],
	upstream: [
		{
			account: "pooled",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
		},
	],
	steps: [
		{
			type: "request",
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "serve only from the pool" }],
			}),
			sessionId: "allowlist",
		},
	],
	assertions: [
		{ id: "allowlisted-seat-serves", type: "upstream", accounts: ["pooled"] },
		{ id: "client-succeeds", type: "client", status: 200 },
	],
});
