import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "one full pooled account queues the next request until its slot is released",
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a"],
			admission_cap: 1,
			admission_queue_limit: 1,
			admission_wait_ms: 1_000,
		},
	},
	fleet: [{ name: "a", accountUuid: "acct-a" }],
	upstream: [
		{
			id: "first-response",
			account: "a",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
			times: 1,
			hold: { received: 1, release: "manual" },
		},
		{ account: "a", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{
			type: "request",
			id: "first",
			waitForCompletion: false,
			waitForUpstream: 1,
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "first" }],
			}),
			sessionId: "admission-first",
		},
		{
			type: "request",
			id: "second",
			waitForCompletion: false,
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "second" }],
			}),
			sessionId: "admission-second",
		},
		{ type: "flush" },
		{ type: "release", id: "first-response" },
		{ type: "await", id: "first" },
		{ type: "await", id: "second" },
	],
	assertions: [
		{
			id: "second-request-waits-for-first-slot",
			type: "upstream",
			count: 2,
			neverWhileHold: "first-response",
		},
		{ id: "both-clients-succeed", type: "client", statuses: [200, 200] },
	],
	upstreamTest: "teamclaude/test/admission-gate.test.js",
});
