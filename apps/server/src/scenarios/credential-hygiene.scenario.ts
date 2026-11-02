import { defineScenario } from "./harness/scenario";

const body = '{"messages":[]}' as const;

export default defineScenario({
	name: "a client Authorization header never reaches the upstream",
	fleet: [{ name: "missing-oauth-bearer", authMethod: "api_key" }],
	upstream: [{ path: "/v1/messages", status: 200, json: { ok: true } }],
	steps: [
		{
			type: "request",
			body,
			headers: { authorization: "Bearer caller-owned-token" },
		},
	],
	assertions: [
		{
			id: "client-authorization-is-not-forwarded",
			type: "upstream",
			count: 1,
			headerAbsent: "authorization",
		},
		{ id: "client-receives-upstream-response", type: "client", status: 200 },
	],
});
