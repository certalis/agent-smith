import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "a manual Claude account pin selects one eligible pooled seat",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["acct-a", "acct-b"],
				},
			},
			anthropic: {
				pool: {
					members: ["acct-a", "acct-b"],
				},
			},
			openai: {
				pool: {
					members: ["acct-a", "acct-b"],
				},
			},
			codex: {
				pool: {
					members: ["acct-a", "acct-b"],
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
