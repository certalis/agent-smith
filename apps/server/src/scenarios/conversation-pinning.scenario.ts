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
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
			admission_cap: 5,
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
