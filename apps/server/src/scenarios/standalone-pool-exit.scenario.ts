import { defineScenario } from "./harness/scenario";
import { standaloneHeaders, standaloneWire } from "./harness/wire-fixture";

export default defineScenario({
	...standaloneWire,
	name: "standalone closes public ingress when its private pool exits unexpectedly",
	upstream: [],
	steps: [
		{
			type: "request",
			id: "ready",
			method: "GET",
			path: "/readyz",
			body: "",
			headers: standaloneHeaders,
		},
		{ type: "terminate-pool" },
		{
			type: "request",
			id: "pool-exited",
			method: "GET",
			path: "/readyz",
			body: "",
			headers: standaloneHeaders,
			allowConnectionRefused: true,
		},
	],
	assertions: [
		{
			id: "pool-was-ready-before-exit",
			type: "client",
			request: "ready",
			status: 200,
			body: "ready\n",
		},
		{
			id: "dead-pool-has-no-public-listener",
			type: "client",
			request: "pool-exited",
			connectionRefused: true,
		},
		{
			id: "lifecycle-probe-reaches-no-provider",
			type: "upstream",
			count: 0,
			connections: 0,
		},
	],
});
