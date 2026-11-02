import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;

export default defineScenario({
	name: "a short per-minute 429 retries the same account without rotating",
	fleet: [{ name: "a" }, { name: "b" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 429,
			headers: { "retry-after": "0" },
			json: { error: { type: "rate_limit_error" }, type: "error" },
		},
		{
			account: "a",
			path: "/v1/messages",
			status: 429,
			headers: { "retry-after": "0" },
			json: { error: { type: "rate_limit_error" }, type: "error" },
		},
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "one-retry-on-the-same-account",
			type: "upstream",
			count: 2,
			accounts: ["a", "a"],
			bodyIdentical: [body, body],
		},
		{
			id: "rate-limit-reaches-client",
			type: "client",
			status: 429,
			header: { name: "retry-after", value: "0" },
		},
	],
	upstreamTest: "teamclaude/test/server-429.test.js",
});
