import { defineScenario } from "./harness/scenario";

const body = '{"messages":[]}' as const;

export default defineScenario({
	name: "seeded rate-limited account is skipped and becomes available",
	fleet: [{ name: "a", rateLimitedFor: "6m" }, { name: "b" }],
	upstream: [
		{
			account: "b",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
		},
	],
	steps: [
		{ type: "request", body },
		{ type: "advance", by: "6m" },
	],
	assertions: [
		{
			id: "skips-seeded-limit",
			type: "upstream",
			count: 1,
			accounts: ["b"],
			bodyIdentical: body,
		},
		{ id: "client-response", type: "client", status: 200 },
		{ id: "current-account", type: "account", current: "b" },
		{ id: "limit-expired", type: "account", notLimited: "a" },
	],
});
