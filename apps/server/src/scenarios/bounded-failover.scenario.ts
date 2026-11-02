import { at, defineScenario } from "./harness/scenario";

const body = '{"messages":[]}' as const;
const rejected = (account: string) => ({
	account,
	path: "/v1/messages",
	status: 429,
	headers: {
		"anthropic-ratelimit-unified-reset": at("1h"),
		"anthropic-ratelimit-unified-status": "rejected",
	},
	json: { error: { type: "rate_limit_error" }, type: "error" },
});

export default defineScenario({
	name: "bounded fleet-wide failover",
	fleet: [{ name: "a" }, { name: "b" }, { name: "c" }],
	upstream: [rejected("a"), rejected("b"), rejected("c")],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "only-one-sibling-hop",
			type: "upstream",
			count: 2,
			accounts: ["a", "b"],
			bodyIdentical: [body, body],
		},
		{ id: "client-rate-limit", type: "client", status: 429 },
	],
	upstreamTest: "teamclaude/test/bounded-failover.test.js",
});
