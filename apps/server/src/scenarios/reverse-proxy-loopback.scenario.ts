import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "a forwarded keyless request cannot spend a pooled credential",
	environment: { CF_PROXY_KEY: "scenario-proxy-key" },
	fleet: [{ name: "pooled" }],
	upstream: [{ path: "/v1/messages", status: 200, json: { ok: true } }],
	steps: [
		{
			type: "request",
			body: '{"messages":[]}',
			headers: { "x-forwarded-for": "203.0.113.7" },
		},
	],
	assertions: [
		{
			id: "forwarded-keyless-request-is-refused",
			type: "client",
			status: 401,
		},
		{
			id: "refused-request-never-reaches-upstream",
			type: "upstream",
			count: 0,
		},
	],
	upstreamTest: "teamclaude/test/reverse-proxy-loopback.test.js",
});
