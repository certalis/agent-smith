import { at, defineScenario } from "./harness/scenario";

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
	name: "a held thread continuation waits for its own seat, not a sooner sibling",
	config: {
		session_duration_ms: 1,
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
			hold_seconds: 30,
		},
	},
	// b is preferred but cooling, so a creates the thread and fills up. b
	// comes back first; only a can continue the thread.
	fleet: [
		{ name: "a", accountUuid: "acct-a", priority: 1 },
		{ name: "b", accountUuid: "acct-b", priority: 0, rateLimitedFor: "10s" },
	],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			times: 1,
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-status": "allowed",
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-5h-utilization": "0.99",
				"anthropic-ratelimit-unified-5h-reset": at("20s"),
			},
			json: { id: "msg_thread", type: "message" },
		},
		{
			account: "a",
			path: "/v1/messages",
			status: 200,
			json: { id: "msg_next", type: "message" },
		},
		{
			account: "b",
			path: "/v1/messages",
			status: 404,
			json: { type: "error", error: { type: "thread_not_found" } },
		},
	],
	steps: [
		{ type: "request", body: createBody, sessionId: "session-thread" },
		{
			type: "request",
			id: "held",
			waitForCompletion: false,
			body: continueBody,
			sessionId: "session-thread",
		},
		{ type: "flush" },
		{ type: "advance", by: "11s" },
		{ type: "flush" },
		{ type: "advance", by: "9s" },
		{ type: "await", id: "held" },
	],
	assertions: [
		{
			id: "the-continuation-reaches-the-thread-seat-after-its-reset",
			type: "upstream",
			accounts: ["a", "a"],
			bodyIdentical: [createBody, continueBody],
		},
		{ id: "the-held-client-is-served", type: "client", statuses: [200, 200] },
	],
});
