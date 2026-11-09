import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "the Node edge forwards private authentication failure before uploading a body",
	edge: { privateTarget: "upstream" },
	fleet: [],
	upstream: [{ status: 401, respondAtHeaders: true }],
	steps: [
		{
			type: "request",
			transport: "edge",
			body: "x",
			upload: "headers-only",
			headers: { "x-api-key": "synthetic-unknown-device" },
		},
	],
	assertions: [
		{
			id: "auth-response-precedes-body",
			type: "client",
			status: 401,
			body: "",
			uploadCompleted: false,
			uploadedBytes: 0,
			uploadBufferedBytes: 0,
		},
		{
			id: "private-auth-sees-key-without-body",
			type: "upstream",
			count: 1,
			connections: 1,
			bodyIdentical: "",
			header: { name: "x-api-key", value: "synthetic-unknown-device" },
		},
	],
});
