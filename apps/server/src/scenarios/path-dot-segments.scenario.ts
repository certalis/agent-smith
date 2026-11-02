import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "an encoded dot-segment path is refused before upstream",
	fleet: [{ name: "a" }],
	upstream: [{ account: "a", status: 200, json: {} }],
	steps: [
		{
			type: "request",
			path: "/v1/claude-code/v1/messages/..%2f..%2fapi/accounts",
			body: "{}",
		},
	],
	assertions: [
		{ id: "path-is-not-forwarded", type: "upstream", count: 0 },
		{ id: "client-sees-invalid-path", type: "client", status: 400 },
	],
	upstreamTest: "teamclaude/test/path-dot-segments.test.js",
});
