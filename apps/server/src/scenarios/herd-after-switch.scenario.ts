import { at, defineScenario } from "./harness/scenario";

const body = '{"messages":[]}' as const;

export default defineScenario({
	name: "herd after a quota switch",
	fleet: [{ name: "a" }, { name: "b" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			times: 10,
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
			times: 10,
			status: 200,
			json: { ok: true },
		},
	],
	steps: [{ type: "request", body, count: 10 }],
	assertions: [
		{
			id: "each-client-uses-at-most-two-upstream-attempts",
			type: "upstream",
			atMostPerHeader: {
				name: "x-ccflare-scenario-client-id",
				count: 2,
			},
			eachHeaderIncludesAccount: {
				name: "x-ccflare-scenario-client-id",
				account: "b",
				count: 10,
			},
			atLeastAccount: { name: "a", count: 1 },
			bodyIdentical: body,
		},
		{ id: "all-clients-succeed", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/storm-control.test.js",
});
