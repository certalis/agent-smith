import { defineScenario } from "./harness/scenario";
import { poolRequest, poolWire } from "./harness/wire-fixture";

export default defineScenario({
	...poolWire,
	name: "the Node edge returns real Bun pool authentication failure before uploading a body",
	upstream: [],
	steps: [
		{
			...poolRequest,
			body: "x",
			upload: "headers-only",
			headers: { "x-api-key": "synthetic-unknown-device" },
		},
	],
	assertions: [
		{
			id: "pool-auth-response-precedes-body",
			type: "client",
			status: 401,
			uploadCompleted: false,
			uploadedBytes: 0,
			uploadBufferedBytes: 0,
		},
		{
			id: "authentication-reaches-no-provider",
			type: "upstream",
			count: 0,
			connections: 0,
		},
	],
});
