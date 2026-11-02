import { at, defineScenario } from "./harness/scenario";

const body = '{"model":"gpt-5.6-sol","input":[],"stream":false}' as const;

export default defineScenario({
	name: "Codex classifies quota windows by stated duration",
	fleet: [{ name: "codex", provider: "codex" }],
	upstream: [
		{
			account: "codex",
			path: "/responses",
			status: 200,
			headers: {
				"x-codex-primary-used-percent": "42",
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-reset-at": at("168h"),
				"x-codex-secondary-used-percent": "0",
				"x-codex-secondary-window-minutes": "300",
				"x-codex-secondary-reset-at": at("5h"),
			},
			json: { ok: true },
		},
	],
	steps: [{ type: "request", path: "/v1/codex/responses", body }],
	assertions: [
		{
			id: "native-codex-request",
			type: "upstream",
			count: 1,
			accounts: ["codex"],
			path: "/responses",
			bodyIdentical: body,
		},
		{
			id: "account-wide-weekly-window",
			type: "account",
			quotaWindow: {
				account: "codex",
				bucket: "unified7d",
				utilization: 0.42,
			},
		},
		{
			id: "account-wide-session-window",
			type: "account",
			quotaWindow: {
				account: "codex",
				bucket: "unified5h",
				utilization: 0,
			},
		},
	],
	upstreamTest: "teamclaude/test/codex-quota.test.js",
});
