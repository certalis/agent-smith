import { servedOnExtraUsageHeaders } from "./harness/quota-headers";
import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-opus-4-5","messages":[]}' as const;

export default defineScenario({
	name: "a 200 served past the plan limit reaches the client instead of a second seat",
	fleet: [{ name: "over-limit" }, { name: "sibling" }],
	upstream: [
		{
			account: "over-limit",
			path: "/v1/messages",
			status: 200,
			headers: servedOnExtraUsageHeaders,
			json: { served: "over-limit" },
		},
		{
			account: "sibling",
			path: "/v1/messages",
			status: 200,
			json: { served: "sibling" },
		},
	],
	steps: [
		{ type: "request", body },
		{ type: "request", body },
	],
	assertions: [
		{
			id: "the-billed-response-is-not-paid-for-twice",
			type: "upstream",
			accounts: ["over-limit", "sibling"],
		},
		{
			id: "the-client-gets-the-billed-response-then-the-sibling",
			type: "client",
			statuses: [200, 200],
		},
		{
			id: "first-response-is-the-one-billed",
			type: "client",
			index: 0,
			jsonPath: { path: "served", value: "over-limit" },
		},
	],
});
