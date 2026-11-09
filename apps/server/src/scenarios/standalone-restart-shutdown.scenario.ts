import { defineScenario } from "./harness/scenario";
import {
	standaloneHeaders,
	standaloneRequest,
	standaloneWire,
} from "./harness/wire-fixture";

export default defineScenario({
	...standaloneWire,
	name: "standalone restarts from its private state and closes public ingress on shutdown",
	fleet: [{ name: "primary", provider: "claude-code" }],
	upstream: [
		{ account: "primary", status: 200, times: 1, json: { stage: "before" } },
		{ account: "primary", status: 200, times: 1, json: { stage: "after" } },
	],
	steps: [
		{ ...standaloneRequest, id: "before" },
		{ type: "restart" },
		{ ...standaloneRequest, id: "after" },
		{ type: "stop" },
		{
			type: "request",
			id: "stopped",
			method: "GET",
			path: "/readyz",
			body: "",
			headers: standaloneHeaders,
			allowConnectionRefused: true,
		},
	],
	assertions: [
		{
			id: "first-instance-serves",
			type: "client",
			request: "before",
			status: 200,
			jsonPath: { path: "stage", value: "before" },
		},
		{
			id: "restarted-instance-keeps-state-and-device-key",
			type: "client",
			request: "after",
			status: 200,
			jsonPath: { path: "stage", value: "after" },
		},
		{
			id: "stopped-instance-accepts-no-connections",
			type: "client",
			request: "stopped",
			connectionRefused: true,
		},
		{
			id: "only-live-instances-reach-provider",
			type: "upstream",
			count: 2,
			accounts: ["primary", "primary"],
			bodyIdentical: standaloneRequest.body,
		},
	],
});
