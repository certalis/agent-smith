import { defineScenario } from "./harness/scenario";

const createBody = JSON.stringify({
	model: "claude-retired",
	thread: { type: "create" },
	messages: [{ role: "user", content: "begin streamed work" }],
});
const continueBody = JSON.stringify({
	model: "claude-retired",
	thread: { type: "continue", previous_message_id: "msg_stream_thread" },
	messages: [{ role: "user", content: "the streamed delta" }],
});
const firstStream =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream_thread"}}\n\n';
const secondStream =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream_next"}}\n\n';

export default defineScenario({
	name: "a streamed message-thread continue stays with its creator account",
	config: { session_duration_ms: 1 },
	// a is unavailable for creation but preferred one second later. The SSE
	// continuation must use b from its saved thread owner rather than reselection.
	fleet: [
		{ name: "a", priority: 0, rateLimitedFor: "1s" },
		{ name: "b", priority: 1 },
	],
	upstream: [
		{
			account: "b",
			path: "/v1/messages",
			status: 200,
			sse: [{ body: firstStream }],
		},
		{
			account: "b",
			path: "/v1/messages",
			status: 200,
			sse: [{ body: secondStream }],
		},
	],
	steps: [
		{ type: "request", body: createBody, sessionId: "session-stream-thread" },
		{ type: "advance", by: "1s" },
		{ type: "advance", by: "1ms" },
		{
			type: "request",
			body: continueBody,
			sessionId: "session-stream-thread",
		},
	],
	assertions: [
		{
			id: "stream-continue-keeps-thread-account",
			type: "upstream",
			count: 2,
			accounts: ["b", "b"],
			bodyIdentical: [createBody, continueBody],
		},
		{ id: "streamed-client-responses", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/message-threads-routing.test.js",
});
