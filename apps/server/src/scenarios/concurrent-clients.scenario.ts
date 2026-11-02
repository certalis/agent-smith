import { defineScenario } from "./harness/scenario";

const body = '{"messages":[{"role":"user","content":"concurrent"}]}' as const;

export default defineScenario({
	name: "concurrent clients preserve request bodies",
	fleet: [{ name: "a" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			times: 10,
			status: 200,
			json: { ok: true },
		},
	],
	steps: [{ type: "request", body, count: 10 }],
	assertions: [
		{
			id: "ten-byte-identical-requests",
			type: "upstream",
			count: 10,
			accounts: Array(10).fill("a"),
			bodyIdentical: Array(10).fill(body),
		},
		{ id: "all-clients-succeed", type: "client", status: 200 },
	],
});
