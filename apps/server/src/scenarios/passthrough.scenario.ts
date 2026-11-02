import { defineScenario } from "./harness/scenario";

const body = '{"messages":[{"role":"user","content":"hello"}]}' as const;

export default defineScenario({
	name: "passthrough",
	fleet: [{ name: "a" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 200,
			json: { content: [], type: "message" },
		},
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "upstream-request",
			type: "upstream",
			count: 1,
			accounts: ["a"],
			path: "/v1/messages",
			header: { name: "authorization", value: "Bearer tok-a" },
			bodyIdentical: body,
		},
		{
			id: "client-response",
			type: "client",
			status: 200,
			body: '{"content":[],"type":"message"}',
		},
		{ id: "current-account", type: "account", current: "a" },
	],
});
