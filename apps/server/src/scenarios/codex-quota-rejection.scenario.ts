import { defineScenario } from "./harness/scenario";

const body = '{"model":"gpt-5.6-sol","input":[],"stream":false}' as const;

export default defineScenario({
	name: "a spent Codex quota response takes one bounded sibling hop",
	fleet: [
		{ name: "codex-a", provider: "codex" },
		{ name: "codex-b", provider: "codex" },
	],
	upstream: [
		{
			account: "codex-a",
			path: "/responses",
			status: 429,
			headers: {
				"retry-after": "0",
				"x-codex-primary-used-percent": "100",
			},
			json: { error: { code: "usage_limit_reached" } },
		},
		{
			account: "codex-b",
			path: "/responses",
			status: 200,
			json: { object: "response", status: "completed" },
		},
	],
	steps: [
		{
			type: "request",
			path: "/v1/codex/responses",
			body,
		},
	],
	assertions: [
		{
			id: "spent-codex-request-uses-one-sibling",
			type: "upstream",
			count: 2,
			accounts: ["codex-a", "codex-b"],
			bodyIdentical: [body, body],
		},
		{ id: "client-receives-the-sibling-response", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/codex-quota-rejection.test.js",
});
