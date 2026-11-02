import { defineScenario } from "./harness/scenario";

const body = '{"messages":[]}' as const;

export default defineScenario({
	name: "exposure checks reject hostile Host and Origin before forwarding",
	environment: {
		CF_ADMIN_KEY: "scenario-admin-key",
		CF_PROXY_KEY: "scenario-proxy-key",
	},
	fleet: [{ name: "pooled" }],
	upstream: [{ path: "/v1/messages", status: 200, json: { ok: true } }],
	steps: [
		{
			body,
			headers: { host: "attacker.example" },
			type: "request",
		},
		{
			body: "{}",
			path: "/api/accounts",
			type: "request",
			headers: {
				origin: "https://attacker.example",
				"x-api-key": "scenario-admin-key",
			},
		},
		{
			body,
			type: "request",
			headers: {
				"x-api-key": "scenario-proxy-key",
				"x-forwarded-for": "203.0.113.7",
			},
		},
	],
	assertions: [
		{
			id: "host-and-cross-origin-writes-are-refused",
			type: "client",
			statuses: [403, 403, 200],
		},
		{
			id: "only-authenticated-forwarded-provider-traffic-reaches-upstream",
			type: "upstream",
			count: 1,
			accounts: ["pooled"],
			bodyIdentical: body,
		},
	],
	upstreamTest: "teamclaude/test/connect-auth.test.js",
});
