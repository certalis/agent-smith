import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;

export default defineScenario({
	name: "a headerless 429 is request-scoped, not an account throttle",
	config: { request_scoped_429_retry_delay_ms: 0 },
	fleet: [{ name: "a" }, { name: "b" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 429,
			json: {
				error: { message: "This model is not available." },
				type: "error",
			},
		},
		{
			account: "b",
			path: "/v1/messages",
			status: 429,
			json: {
				error: { message: "This model is not available." },
				type: "error",
			},
		},
		{
			account: "b",
			path: "/v1/messages",
			status: 429,
			json: {
				error: { message: "This model is not available." },
				type: "error",
			},
		},
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "bounded-request-scoped-attempts",
			type: "upstream",
			count: 3,
			accounts: ["a", "b", "b"],
			bodyIdentical: [body, body, body],
		},
		{
			id: "request-scoped-429-reaches-client",
			type: "client",
			status: 429,
			headerAbsent: "retry-after",
		},
		{ id: "account-a-stays-available", type: "account", notLimited: "a" },
		{ id: "account-b-stays-available", type: "account", notLimited: "b" },
	],
	upstreamTest: "teamclaude/test/request-scoped-429.test.js",
});
