import { defineScenario } from "./harness/scenario";
import { standaloneRequest, standaloneWire } from "./harness/wire-fixture";

export default defineScenario({
	...standaloneWire,
	standalone: false,
	edge: {},
	name: "a device key cannot call a direct provider route",
	config: {
		providers: {
			"reach-provider": { enabled: true, strategy: "anthropic-api" },
		},
		provider_pools: { "anthropic-messages": ["reach-provider"] },
		team_routing: {
			enabled: true,
			caller_provider_fallback: { "synthetic-device": "ordered" },
		},
	},
	fleet: [{ name: "key", provider: "reach-provider", authMethod: "api_key" }],
	upstream: [],
	steps: [
		{
			...standaloneRequest,
			path: "/v1/reach-provider/v1/messages",
			body: '{"model":"claude-sonnet-4-5","messages":[]}',
		},
	],
	assertions: [
		{ id: "direct-device-is-forbidden", type: "client", status: 403 },
		{ id: "direct-device-never-reaches-provider", type: "upstream", count: 0 },
	],
});
