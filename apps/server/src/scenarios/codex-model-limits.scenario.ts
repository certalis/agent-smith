import { defineScenario } from "./harness/scenario";

const body = '{"model":"gpt-5.6-sol","input":[],"stream":false}' as const;

export default defineScenario({
	name: "Codex preserves the active model limit header",
	fleet: [{ name: "codex", provider: "codex" }],
	upstream: [
		{
			account: "codex",
			path: "/responses",
			status: 200,
			headers: { "x-codex-active-limit": "premium" },
			json: { ok: true },
		},
	],
	steps: [{ type: "request", path: "/v1/codex/responses", body }],
	assertions: [
		{
			id: "native-request-body",
			type: "upstream",
			count: 1,
			accounts: ["codex"],
			path: "/responses",
			bodyIdentical: body,
		},
		{
			id: "active-limit-reaches-client",
			type: "client",
			status: 200,
			header: { name: "x-codex-active-limit", value: "premium" },
		},
	],
	upstreamTest: "teamclaude/test/codex-model-limits.test.js",
});
