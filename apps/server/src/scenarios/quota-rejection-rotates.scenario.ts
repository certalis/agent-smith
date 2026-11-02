import { at, defineScenario } from "./harness/scenario";

const body = '{"messages":[]}' as const;

export default defineScenario({
	name: "quota rejection rotates to the next account",
	fleet: [{ name: "a" }, { name: "b" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 429,
			headers: {
				"anthropic-ratelimit-unified-reset": at("1h"),
				"anthropic-ratelimit-unified-status": "rejected",
			},
			json: { error: { type: "rate_limit_error" }, type: "error" },
		},
		{
			account: "b",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
		},
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "rotates-after-rejection",
			type: "upstream",
			count: 2,
			accounts: ["a", "b"],
			bodyIdentical: [body, body],
		},
		{ id: "client-response", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/server-429.test.js",
});
