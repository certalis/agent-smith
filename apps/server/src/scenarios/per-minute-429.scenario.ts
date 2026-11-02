import { at, defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;

export default defineScenario({
	name: "a long per-minute 429 pauses one account and reaches the client",
	fleet: [{ name: "a" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 429,
			headers: { "retry-after": "300" },
			json: {
				error: { type: "rate_limit_error" },
				type: "error",
			},
		},
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "one-upstream-request-for-a-long-wait",
			type: "upstream",
			count: 1,
			accounts: ["a"],
			bodyIdentical: body,
		},
		{
			id: "rate-limit-reaches-client",
			type: "client",
			status: 429,
			header: { name: "retry-after", value: "300" },
		},
		{
			id: "account-paused-for-retry-window",
			type: "account",
			limited: "a",
			limitedUntil: at("5m"),
		},
	],
	upstreamTest: "teamclaude/test/server-429.test.js",
});
