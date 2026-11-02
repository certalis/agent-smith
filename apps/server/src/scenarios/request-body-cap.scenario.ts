import { defineScenario } from "./harness/scenario";

const body = `{"messages":[{"role":"user","content":"${"x".repeat(256)}"}]}`;

export default defineScenario({
	name: "a request over the body cap is refused before upstream",
	config: { max_body_bytes: 128 },
	fleet: [{ name: "a" }],
	upstream: [{ account: "a", path: "/v1/messages", status: 200, json: {} }],
	steps: [{ type: "request", body }],
	assertions: [
		{ id: "request-is-not-forwarded", type: "upstream", count: 0 },
		{ id: "client-sees-payload-too-large", type: "client", status: 413 },
	],
	upstreamTest: "teamclaude/test/request-body-cap.test.js",
});
