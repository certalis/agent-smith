import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;
const spentWindow = (resetAt: number) => ({
	windows: {
		unified5h: {
			resetAt,
			seenAt: 1_700_000_000_000,
			status: "allowed",
			utilization: 0.99,
		},
	},
});

export default defineScenario({
	name: "an all-spent fleet permits one real revalidation request per minute",
	config: { block_when_all_full: false },
	fleet: [
		{ name: "a", quotaState: spentWindow(1_700_000_060_000) },
		{ name: "b", quotaState: spentWindow(1_700_000_120_000) },
	],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
			times: 2,
		},
	],
	steps: [
		{ type: "request", body },
		{ type: "request", body },
		{ type: "advance", by: "1m" },
		{ type: "request", body },
	],
	assertions: [
		{
			id: "one-soonest-reset-probe-reaches-upstream",
			type: "upstream",
			count: 2,
			accounts: ["a", "a"],
			bodyIdentical: [body, body],
		},
		{
			id: "only-one-client-per-minute-revalidates",
			type: "client",
			statuses: [200, 429, 200],
		},
		{
			id: "exhaustion-names-the-soonest-reset",
			type: "client",
			index: 1,
			status: 429,
			header: { name: "retry-after", value: "60" },
		},
	],
	upstreamTest: "teamclaude/test/per-account-threshold.test.js",
});
