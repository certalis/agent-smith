import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "a protected Claude seat outside the allowlist never receives pooled traffic",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["pooled-account"],
				},
			},
			anthropic: {
				pool: {
					members: ["pooled-account"],
				},
			},
			openai: {
				pool: {
					members: ["pooled-account"],
				},
			},
			codex: {
				pool: {
					members: ["pooled-account"],
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
