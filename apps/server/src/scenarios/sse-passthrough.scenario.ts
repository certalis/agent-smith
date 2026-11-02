import { defineScenario } from "./harness/scenario";

const body = '{"stream":true,"messages":[]}' as const;
const firstChunk =
	'event: message_start\ndata: {"type":"message_start"}\n\n' as const;
const secondChunk =
	'event: message_stop\ndata: {"type":"message_stop"}\n\n' as const;

export default defineScenario({
	name: "SSE passthrough",
	fleet: [{ name: "a" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 200,
			sse: [
				{ body: firstChunk },
				{ body: secondChunk, afterClientChunk: true },
			],
		},
	],
	steps: [{ type: "request", body }],
	assertions: [
		{
			id: "upstream-request",
			type: "upstream",
			count: 1,
			accounts: ["a"],
			bodyIdentical: body,
		},
		{
			id: "SSE-client-response",
			type: "client",
			status: 200,
			header: { name: "content-type", value: "text/event-stream" },
			body: `${firstChunk}${secondChunk}`,
			chunks: [firstChunk, secondChunk],
		},
	],
});
