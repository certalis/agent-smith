import { at, defineScenario } from "./harness/scenario";

const body = '{"model":"gpt-5.6-sol","input":[],"stream":false}' as const;

export default defineScenario({
	name: "Codex response headers retain only the quota windows they state",
	fleet: [{ name: "codex", provider: "codex" }],
	upstream: [
		{
			account: "codex",
			path: "/responses",
			status: 200,
			headers: {
				"x-codex-primary-used-percent": "42",
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-reset-at": at("1h"),
			},
			json: { ok: true },
		},
	],
	steps: [{ type: "request", path: "/v1/codex/responses", body }],
	assertions: [
		{
			id: "codex-request-is-native",
			type: "upstream",
			count: 1,
			accounts: ["codex"],
			path: "/responses",
			header: { name: "authorization", value: "Bearer tok-codex" },
			bodyIdentical: body,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
		{
			id: "weekly-window-is-recorded",
			type: "account",
			quotaWindow: {
				account: "codex",
				bucket: "unified7d",
				utilization: 0.42,
			},
		},
		{
			id: "unstated-session-window-is-absent",
			type: "account",
			quotaWindowAbsent: { account: "codex", bucket: "unified5h" },
		},
	],
	upstreamTest: "teamclaude/test/codex-quota-headers.test.js",
});
