import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "Codex OAuth initialization exposes the native browser authorization flow",
	upstreamTest: "teamclaude/test/codex-auth.test.js",
	config: { providers: { codex: { enabled: true } } },
	environment: { AGENT_SMITH_ADMIN_KEY: "scenario-admin" },
	fleet: [],
	upstream: [],
	steps: [
		{
			type: "request",
			path: "/api/auth/codex/init",
			body: JSON.stringify({ name: "codex-browser-account" }),
			headers: { "x-api-key": "scenario-admin" },
		},
	],
	assertions: [
		{
			id: "codex-oauth-init-succeeds",
			type: "client",
			status: 200,
		},
		{
			id: "codex-oauth-uses-native-scope-set",
			type: "client",
			bodyIncludes: "scope=openid+profile+email+offline_access&",
		},
		{
			id: "codex-oauth-uses-native-cli-origin",
			type: "client",
			bodyIncludes: "originator=codex_cli_rs",
		},
	],
});
