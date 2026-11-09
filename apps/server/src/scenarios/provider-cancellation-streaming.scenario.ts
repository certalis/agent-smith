import { defineScenario } from "./harness/scenario";
import { poolRequest, poolWire, providerChunk } from "./harness/wire-fixture";

export default defineScenario({
	...poolWire,
	name: "client disconnect cancels the actual Node provider while streaming without retrying",
	upstream: [
		{ status: 200, sse: [{ body: providerChunk }], keepOpen: "after-chunks" },
	],
	steps: [
		{ ...poolRequest, id: "cancelled", waitForCompletion: false },
		{ type: "wait-for-client-chunk", id: "cancelled" },
		{
			type: "assert",
			assertions: [
				{
					id: "provider-is-still-streaming",
					type: "upstream",
					count: 1,
					closed: 0,
					responsesEnded: 0,
				},
			],
		},
		{ type: "cancel", id: "cancelled" },
		{ type: "wait-for-upstream-close", count: 1 },
		{ type: "await", id: "cancelled" },
	],
	assertions: [
		{
			id: "client-received-first-chunk",
			type: "client",
			status: 200,
			bodyIncludes: "first",
			cancelled: true,
		},
		{
			id: "provider-connection-closes-without-retry",
			type: "upstream",
			count: 1,
			connections: 1,
			closed: 1,
			responsesEnded: 0,
			accounts: ["primary"],
			bodyIdentical: poolRequest.body,
		},
	],
});
