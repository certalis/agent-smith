import { defineScenario } from "./harness/scenario";
import { wireDeviceKey } from "./harness/wire-fixture";

const first = "data: first\n\n";

export default defineScenario({
	name: "the Node edge streams, cancels its private connection, and refuses non-inference routes",
	edge: { privateTarget: "upstream" },
	fleet: [],
	upstream: [{ status: 200, sse: [{ body: first }], keepOpen: "after-chunks" }],
	steps: [
		{
			type: "request",
			transport: "edge",
			method: "GET",
			path: "/v1/claude-code/v1/messages",
			body: "",
		},
		{
			type: "request",
			transport: "edge",
			method: "GET",
			path: "/api/accounts",
			body: "",
		},
		{
			type: "assert",
			assertions: [
				{
					id: "rejected-routes-open-no-private-connection",
					type: "upstream",
					count: 0,
					connections: 0,
				},
			],
		},
		{
			type: "request",
			transport: "edge",
			id: "stream",
			body: "",
			waitForCompletion: false,
		},
		{ type: "wait-for-client-chunk", id: "stream" },
		{
			type: "assert",
			assertions: [
				{
					id: "first-byte-arrives-before-upstream-ends",
					type: "upstream",
					count: 1,
					closed: 0,
					responsesEnded: 0,
				},
			],
		},
		{ type: "cancel", id: "stream" },
		{ type: "wait-for-upstream-close", count: 1 },
		{ type: "await", id: "stream" },
	],
	assertions: [
		{ id: "routes-stay-private", type: "client", statuses: [404, 404, 200] },
		{
			id: "stream-is-observed-before-cancellation",
			type: "client",
			request: "stream",
			body: first,
			chunks: [first],
			cancelled: true,
		},
		{
			id: "one-private-stream-is-destroyed",
			type: "upstream",
			count: 1,
			connections: 1,
			closed: 1,
			responsesEnded: 0,
			header: { name: "x-api-key", value: wireDeviceKey },
		},
	],
});
