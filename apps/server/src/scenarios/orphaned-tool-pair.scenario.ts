import { defineScenario } from "./harness/scenario";

const body =
	'{"model":"claude-retired","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"tool_use","id":"toolu_orphan","name":"lookup","input":{}}]}]}' as const;
const rewritten =
	'{"model":"claude-retired","messages":[{"role":"user","content":"hi"}]}' as const;

export default defineScenario({
	name: "an orphaned tool use is removed before upstream",
	fleet: [{ name: "a" }],
	upstream: [{ account: "a", path: "/v1/messages", status: 200, json: {} }],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "orphaned-tool-is-rewritten",
			type: "upstream",
			count: 1,
			bodyIdentical: rewritten,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/tool-pair-sanitize.test.js",
});
