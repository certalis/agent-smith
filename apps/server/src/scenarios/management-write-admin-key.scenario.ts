import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "a management write needs a configured matching admin key",
	fleet: [],
	upstream: [],
	steps: [{ type: "request", path: "/api/accounts", body: "{}" }],
	assertions: [
		{ id: "keyless-write-is-refused", type: "client", status: 401 },
		{ id: "write-never-becomes-provider-traffic", type: "upstream", count: 0 },
	],
	upstreamTest: "teamclaude/test/control-csrf.test.js",
});
