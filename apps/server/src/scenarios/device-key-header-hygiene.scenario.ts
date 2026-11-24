import { defineScenario } from "./harness/scenario";

const body = '{"messages":[]}' as const;

export default defineScenario({
	name: "a device key sent to name a caller never reaches the upstream",
	fleet: [{ name: "provider-account", authMethod: "api_key" }],
	upstream: [{ path: "/v1/messages", status: 200, json: { ok: true } }],
	steps: [
		{
			type: "request",
			body,
			headers: {
				"x-agent-smith-device-key": "synthetic-caller-device-key-0003",
			},
		},
	],
	assertions: [
		{
			id: "device-key-header-is-not-forwarded",
			type: "upstream",
			count: 1,
			headerAbsent: "x-agent-smith-device-key",
		},
		{ id: "client-receives-upstream-response", type: "client", status: 200 },
	],
});
