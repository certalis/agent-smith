import { defineScenario } from "./harness/scenario";
import {
	providerChunk,
	standaloneRequest,
	standaloneWire,
	wireProxyKey,
} from "./harness/wire-fixture";

export default defineScenario({
	...standaloneWire,
	name: "standalone shutdown forces an unfinished stream closed after its grace deadline",
	fleet: [{ name: "primary", provider: "claude-code" }],
	upstream: [
		{ status: 200, sse: [{ body: providerChunk }], keepOpen: "after-chunks" },
	],
	steps: [
		{
			...standaloneRequest,
			id: "unfinished",
			transport: "unix",
			headers: { "x-api-key": wireProxyKey },
			waitForCompletion: false,
			allowResponseInterrupted: true,
		},
		{ type: "wait-for-client-chunk", id: "unfinished" },
		{ type: "begin-stop" },
		{
			type: "assert",
			assertions: [
				{
					id: "shutdown-preserves-stream-before-grace-deadline",
					type: "upstream",
					count: 1,
					closed: 0,
					responsesEnded: 0,
				},
			],
		},
		{ type: "advance", by: "26s" },
		{ type: "await", id: "unfinished" },
		{ type: "await-stop" },
		{ type: "wait-for-upstream-close", count: 1 },
	],
	assertions: [
		{
			id: "grace-deadline-interrupts-the-existing-stream",
			type: "client",
			request: "unfinished",
			status: 200,
			responseInterrupted: true,
		},
		{
			id: "forced-shutdown-closes-provider-without-replay",
			type: "upstream",
			count: 1,
			closed: 1,
			responsesEnded: 0,
		},
	],
});
