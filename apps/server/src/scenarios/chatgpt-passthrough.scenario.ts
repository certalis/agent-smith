import { defineScenario } from "./harness/scenario";

const body =
	'{"model":"gpt-5.6-sol","input":[{"role":"user","content":"workspace request"}],"stream":false}' as const;

export default defineScenario({
	name: "Codex forwards ChatGPT request bytes without translation",
	fleet: [{ name: "codex", provider: "codex" }],
	upstream: [
		{
			account: "codex",
			path: "/responses",
			status: 200,
			json: { ok: true },
		},
	],
	steps: [{ type: "request", path: "/v1/codex/responses", body }],
	assertions: [
		{
			id: "chatgpt-backend-route",
			type: "upstream",
			count: 1,
			accounts: ["codex"],
			path: "/responses",
			header: { name: "originator", value: "codex_cli_rs" },
			bodyIdentical: body,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/chatgpt-passthrough.test.js",
});
