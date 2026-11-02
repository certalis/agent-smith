import { defineScenario } from "./harness/scenario";

const body =
	'{"model":"claude-retired","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"private chain","signature":"sig"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_orphan","content":"unpaired"}]}]}' as const;
const rewritten =
	'{"model":"claude-retired","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"private chain","signature":"sig"}]}]}' as const;

export default defineScenario({
	name: "an orphaned tool result is removed without changing a thinking block",
	fleet: [{ name: "a" }],
	upstream: [{ account: "a", path: "/v1/messages", status: 200, json: {} }],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "orphaned-tool-result-is-rewritten-and-thinking-is-preserved",
			type: "upstream",
			count: 1,
			bodyIdentical: rewritten,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/tool-pair-sanitize.test.js",
});
