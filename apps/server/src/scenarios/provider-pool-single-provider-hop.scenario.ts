import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

function spentAccount(name: string) {
	return {
		name,
		provider: "claude-code",
		quotaState: {
			windows: {
				unified5h: {
					resetAt: now + 60 * 60 * 1_000,
					seenAt: now,
					status: "rejected" as const,
					utilization: 1,
				},
			},
		},
	};
}

export default defineScenario({
	name: "a pool does not walk past its next spent provider",
	config: {
		providers: {
			"claude-code": { enabled: true },
			acme: { enabled: true, strategy: "anthropic-api" },
			backup: { enabled: true, strategy: "anthropic-api" },
		},
		provider_pools: {
			"anthropic-messages": ["claude-code", "acme", "backup"],
		},
	},
	fleet: [
		spentAccount("claude"),
		{ ...spentAccount("acme"), provider: "acme" },
		{ name: "backup", provider: "backup", authMethod: "api_key" },
	],
	upstream: [
		{
			account: "backup",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
		},
	],
	steps: [
		{
			type: "request",
			path: "/v1/pool/anthropic-messages/v1/messages",
			body,
		},
	],
	assertions: [
		{ id: "third-provider-is-not-contacted", type: "upstream", accounts: [] },
		{ id: "next-provider-exhaustion-is-returned", type: "client", status: 429 },
	],
});
