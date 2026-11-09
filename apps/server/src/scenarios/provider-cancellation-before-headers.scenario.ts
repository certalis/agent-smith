import { defineScenario } from "./harness/scenario";
import { poolRequest, poolWire } from "./harness/wire-fixture";

export default defineScenario({
	...poolWire,
	name: "client disconnect cancels the actual Node provider before headers without retrying",
	upstream: [{ status: 200, keepOpen: "before-headers" }],
	steps: [
		{
			...poolRequest,
			id: "cancelled",
			waitForCompletion: false,
			waitForUpstream: 1,
		},
		{ type: "cancel", id: "cancelled" },
		{ type: "wait-for-upstream-close", count: 1 },
		{ type: "await", id: "cancelled" },
	],
	assertions: [
		{
			id: "client-received-no-headers-or-chunks",
			type: "client",
			status: 0,
			chunks: [],
			body: "",
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
