import { defineScenario } from "./harness/scenario";

const body =
	'{"model":"claude-sonnet-4-5","messages":[],"stream":true}' as const;
const start =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n' as const;
const failed =
	'event: error\ndata: {"type":"error","error":{"type":"server_error"}}\n\n' as const;

export default defineScenario({
	name: "a pool never switches provider after the first streamed byte",
	config: {
		providers: {
			"claude-code": { enabled: true },
			acme: { enabled: true, strategy: "anthropic-api" },
		},
		provider_pools: {
			"anthropic-messages": ["claude-code", "acme"],
		},
	},
	fleet: [
		{ name: "claude", provider: "claude-code" },
		{ name: "acme", provider: "acme", authMethod: "api_key" },
	],
	upstream: [
		{
			account: "claude",
			path: "/v1/messages",
			status: 200,
			sse: [{ body: start }, { body: failed }],
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
		{
			id: "only-first-provider-is-contacted",
			type: "upstream",
			accounts: ["claude"],
			bodyIdentical: body,
		},
		{
			id: "client-receives-original-stream",
			type: "client",
			status: 200,
			body: `${start}${failed}`,
		},
	],
});
