import { defineScenario } from "./harness/scenario";
import {
	standaloneHeaders,
	standaloneRequest,
	standaloneWire,
	wireProxyKey,
} from "./harness/wire-fixture";

export default defineScenario({
	...standaloneWire,
	upstreamRuntime: "bun",
	name: "standalone shutdown lets outstanding public and private replies finish before exiting",
	fleet: [{ name: "primary", provider: "claude-code" }],
	upstream: [
		{
			id: "held-reply",
			status: 200,
			json: { completed: true },
			hold: { received: 2, release: "manual" },
		},
	],
	steps: [
		{
			...standaloneRequest,
			id: "public-reply",
			waitForCompletion: false,
			waitForUpstream: 1,
		},
		{
			...standaloneRequest,
			id: "private-reply",
			transport: "unix",
			headers: { "x-api-key": wireProxyKey },
			waitForCompletion: false,
			waitForUpstream: 2,
		},
		{ type: "begin-stop" },
		{ type: "release", id: "held-reply" },
		{ type: "await", id: "public-reply" },
		{ type: "await", id: "private-reply" },
		{ type: "await-stop" },
		{
			type: "request",
			id: "closed-public-listener",
			method: "GET",
			path: "/readyz",
			body: "",
			headers: standaloneHeaders,
			allowConnectionRefused: true,
		},
	],
	assertions: [
		...(["public-reply", "private-reply"] as const).map((request) => ({
			id: `shutdown-preserves-${request}`,
			type: "client" as const,
			request,
			status: 200,
			jsonPath: { path: "completed", value: true },
		})),
		{
			id: "completed-shutdown-closes-public-ingress",
			type: "client",
			request: "closed-public-listener",
			connectionRefused: true,
		},
		{
			id: "shutdown-does-not-replay-provider-work",
			type: "upstream",
			count: 2,
			bodyIdentical: standaloneRequest.body,
		},
	],
});
