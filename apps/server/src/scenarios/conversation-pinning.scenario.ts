import { defineScenario } from "./harness/scenario";

const openingA = JSON.stringify({
	model: "claude-opus-4-5",
	messages: [{ role: "user", content: "research the red fox" }],
});

const openingB = JSON.stringify({
	model: "claude-opus-4-5",
	messages: [{ role: "user", content: "research the blue whale" }],
});

const continuationA = JSON.stringify({
	model: "claude-opus-4-5",
	messages: [
		{ role: "user", content: "research the red fox" },
		{ role: "assistant", content: "A fox is a mammal." },
		{ role: "user", content: "give me one more fact" },
	],
});

export default defineScenario({
	name: "different openings in one Claude session spread and each stay pinned",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 5,
					},
				},
			},
			anthropic: {
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 5,
					},
				},
			},
			openai: {
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 5,
					},
				},
			},
			codex: {
				pool: {
					members: ["acct-a", "acct-b"],
					admission: {
						cap: 5,
					},
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
		{ account: "a", path: "/v1/messages", status: 200, json: { ok: true } },
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", body: openingA, sessionId: "shared-session" },
		{ type: "request", body: openingB, sessionId: "shared-session" },
		{ type: "request", body: continuationA, sessionId: "shared-session" },
	],
	assertions: [
		{
			id: "openings-spread-and-continuation-keeps-its-account",
			type: "upstream",
			accounts: ["a", "b", "a"],
		},
	],
	upstreamTest: "teamclaude/test/conversation-distribution.test.js",
});
