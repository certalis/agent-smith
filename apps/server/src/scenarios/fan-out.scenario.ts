import { defineScenario } from "./harness/scenario";

const body = '{"messages":[]}' as const;
const sessionId = "scenario-fan-out";

export default defineScenario({
	name: "fan-out preserves the Claude Code session header",
	fleet: [{ name: "a" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			times: 8,
			status: 200,
			json: { ok: true },
		},
	],
	steps: [{ type: "request", body, count: 8, sessionId }],
	assertions: [
		{
			id: "session-fan-out",
			type: "upstream",
			count: 8,
			accounts: Array(8).fill("a"),
			header: { name: "x-claude-code-session-id", value: sessionId },
			bodyIdentical: Array(8).fill(body),
		},
		{ id: "all-clients-succeed", type: "client", status: 200 },
	],
});
