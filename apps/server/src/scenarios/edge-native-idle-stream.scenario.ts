import { defineScenario } from "./harness/scenario";
import { poolRequest, poolWire } from "./harness/wire-fixture";

const first =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic-idle"}}\n\n';
const last = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

export default defineScenario({
	...poolWire,
	name: "the Node edge preserves a real Unix stream across a native socket idle gap",
	upstream: [
		{
			status: 200,
			sse: [{ body: first }, { body: last, nativeIdleGap: "12s" }],
		},
	],
	steps: [
		{ ...poolRequest, id: "quiet-stream", waitForCompletion: false },
		{ type: "wait-for-client-chunk", id: "quiet-stream" },
		{
			type: "assert",
			assertions: [
				{
					id: "first-frame-is-not-buffered",
					type: "upstream",
					count: 1,
					responsesEnded: 0,
				},
			],
		},
		{ type: "await", id: "quiet-stream" },
	],
	assertions: [
		{
			id: "both-frames-survive-the-idle-gap",
			type: "client",
			request: "quiet-stream",
			status: 200,
			body: first + last,
			chunks: [first, last],
		},
		{
			id: "quiet-stream-is-never-replayed",
			type: "upstream",
			count: 1,
			responsesEnded: 1,
		},
	],
});
