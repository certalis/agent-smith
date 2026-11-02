import { at, defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;

export default defineScenario({
	name: "an organization-restricted 403 quarantines one account and fails over",
	fleet: [{ name: "a" }, { name: "b" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 403,
			json: {
				error: { type: "oauth_not_allowed_for_organization" },
				type: "error",
			},
		},
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "request-reaches-one-eligible-sibling",
			type: "upstream",
			count: 2,
			accounts: ["a", "b"],
		},
		{
			id: "restricted-account-is-quarantined-for-five-minutes",
			type: "account",
			limited: "a",
			limitedUntil: at("5m"),
		},
		{ id: "sibling-response-reaches-client", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/server-403.test.js",
});
