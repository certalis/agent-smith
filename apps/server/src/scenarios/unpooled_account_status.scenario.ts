import { defineScenario } from "./harness/scenario";
import pooled from "./non_claude_pool_status.scenario";

export default defineScenario({
	...pooled,
	name: "caller status counts a reachable personal seat without a pool",
	config: {
		providers: {
			"claude-code": { enabled: true },
			second: { enabled: true, strategy: "claude-code" },
		},
		routing: {
			routes: { "anthropic-messages": ["second"] },
			api_key_accounts: "chooser_or_fallback",
		},
	},
	assertions: [
		{
			id: "personal-seat-status",
			type: "client",
			request: "status",
			status: 200,
			body: JSON.stringify({
				version: 1,
				pool: "anthropic-messages",
				provider: "second",
				routingEnabled: false,
				eligibleAccounts: 1,
				retryAtMs: null,
				holdSeconds: 0,
				admissionWaitMs: 30000,
			}),
		},
		{
			id: "personal-seat-serves",
			type: "client",
			request: "serve",
			status: 200,
		},
		{ id: "personal-provider", type: "upstream", accounts: ["second-seat"] },
	],
});
