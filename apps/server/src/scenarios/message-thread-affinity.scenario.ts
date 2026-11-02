import { defineScenario } from "./harness/scenario";

const createBody = JSON.stringify({
	model: "claude-retired",
	thread: { type: "create" },
	messages: [{ role: "user", content: "begin work" }],
});
const continueBody = JSON.stringify({
	model: "claude-retired",
	thread: { type: "continue", previous_message_id: "msg_thread" },
	messages: [{ role: "user", content: "the next delta" }],
});

export default defineScenario({
	name: "a message-thread continue stays with the account that created it",
	config: { session_duration_ms: 1 },
	// a is temporarily unavailable for creation, then becomes the preferred
	// account. Only the stored thread owner can keep the continuation on b.
	fleet: [
		{ name: "a", priority: 0, rateLimitedFor: "1s" },
		{ name: "b", priority: 1 },
	],
	upstream: [
		{
			account: "b",
			path: "/v1/messages",
			status: 200,
			json: { id: "msg_thread", type: "message" },
		},
		{
			account: "b",
			path: "/v1/messages",
			status: 200,
			json: { id: "msg_next", type: "message" },
		},
	],
	steps: [
		{ type: "request", body: createBody, sessionId: "session-thread" },
		{ type: "advance", by: "1s" },
		{ type: "advance", by: "1ms" },
		{ type: "request", body: continueBody, sessionId: "session-thread" },
	],
	assertions: [
		{
			id: "continue-keeps-thread-account",
			type: "upstream",
			count: 2,
			accounts: ["b", "b"],
			bodyIdentical: [createBody, continueBody],
		},
		{ id: "client-receives-both-messages", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/message-threads-routing.test.js",
});
