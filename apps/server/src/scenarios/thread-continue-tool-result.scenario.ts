import { defineScenario } from "./harness/scenario";

const continueBody = JSON.stringify({
	model: "claude-retired",
	thread: { type: "continue", previous_message_id: "msg_previous" },
	messages: [
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "toolu_thread",
					content: "done",
				},
			],
		},
		{
			role: "system",
			content: [{ type: "text", text: "a mid-conversation reminder" }],
		},
	],
});

export default defineScenario({
	name: "a message-thread continuation with a tool result is forwarded unchanged",
	fleet: [{ name: "a" }],
	upstream: [{ account: "a", path: "/v1/messages", status: 200, json: {} }],
	steps: [{ type: "request", body: continueBody }],
	assertions: [
		{
			id: "thread-continue-is-byte-identical",
			type: "upstream",
			count: 1,
			bodyIdentical: continueBody,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/tool-pair-sanitize.test.js",
});
