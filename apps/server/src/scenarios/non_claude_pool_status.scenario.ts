import { defineScenario } from "./harness/scenario";
import {
	standaloneRequest,
	standaloneWire,
	wireDeviceKey,
	wireProxyKey,
} from "./harness/wire-fixture";

const body = '{"model":"claude-sonnet-4-5","messages":[]}';
export default defineScenario({
	...standaloneWire,
	name: "caller status and serving use a non-Claude pool without a Claude pool",
	config: {
		providers: {
			"claude-code": { enabled: true },
			second: {
				enabled: true,
				strategy: "claude-code",
				pool: { members: ["second-seat"], admission: { wait_ms: 7000 } },
			},
		},
		routing: {
			routes: { "anthropic-messages": ["second"] },
			api_key_accounts: "chooser_or_fallback",
		},
	},
	fleet: [
		{ name: "second-seat", provider: "second", accountUuid: "second-seat" },
	],
	upstream: [
		{
			account: "second-seat",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
		},
	],
	steps: [
		{
			type: "request",
			transport: "unix",
			id: "status",
			method: "GET",
			path: "/api/pool-status?pool=anthropic-messages",
			headers: {
				"x-api-key": wireProxyKey,
				"x-agent-smith-device-key": wireDeviceKey,
			},
			body: "",
		},
		{ ...standaloneRequest, id: "serve", body },
	],
	assertions: [
		{
			id: "caller-reaches-second-pool",
			type: "client",
			request: "status",
			status: 200,
			body: JSON.stringify({
				version: 1,
				pool: "anthropic-messages",
				provider: "second",
				routingEnabled: true,
				eligibleAccounts: 1,
				retryAtMs: null,
				holdSeconds: 0,
				admissionWaitMs: 7000,
			}),
		},
		{ id: "seat-serves", type: "client", request: "serve", status: 200 },
		{ id: "correct-provider", type: "upstream", accounts: ["second-seat"] },
	],
});
