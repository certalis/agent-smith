import { defineScenario } from "./harness/scenario";
import { poolRequest, poolWire, providerChunk } from "./harness/wire-fixture";

export default defineScenario({
	...poolWire,
	name: "the Node edge rejects excess requests and releases its slot after cancellation",
	edge: { maxConcurrentRequests: 1 },
	upstream: [
		{ status: 200, sse: [{ body: providerChunk }], keepOpen: "after-chunks" },
	],
	steps: [
		{ ...poolRequest, id: "first", waitForCompletion: false },
		{ type: "wait-for-client-chunk", id: "first" },
		{ ...poolRequest, id: "blocked" },
		{
			type: "assert",
			assertions: [
				{
					id: "held-stream-reserves-only-slot",
					type: "client",
					request: "blocked",
					status: 503,
				},
				{
					id: "rejection-opens-no-provider-connection",
					type: "upstream",
					count: 1,
					connections: 1,
					closed: 0,
					responsesEnded: 0,
				},
			],
		},
		{ type: "cancel", id: "first" },
		{ type: "wait-for-upstream-close", count: 1 },
		{ type: "await", id: "first" },
		{ ...poolRequest, id: "replacement", waitForCompletion: false },
		{ type: "wait-for-client-chunk", id: "replacement" },
		{ type: "cancel", id: "replacement" },
		{ type: "wait-for-upstream-close", count: 2 },
		{ type: "await", id: "replacement" },
	],
	assertions: [
		{
			id: "first-stream-started",
			type: "client",
			request: "first",
			status: 200,
			bodyIncludes: "first",
			cancelled: true,
		},
		{
			id: "replacement-stream-uses-released-slot",
			type: "client",
			request: "replacement",
			status: 200,
			bodyIncludes: "first",
			cancelled: true,
		},
		{
			id: "only-admitted-streams-reach-provider",
			type: "upstream",
			count: 2,
			connections: 2,
			closed: 2,
			responsesEnded: 0,
			bodyIdentical: poolRequest.body,
		},
	],
});
