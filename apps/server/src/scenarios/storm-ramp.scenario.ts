import { at, defineScenario } from "./harness/scenario";

const request = (opening: string) => ({
	body: JSON.stringify({
		model: "claude-opus-4-5",
		messages: [{ role: "user", content: opening }],
	}),
	sessionId: `storm-${opening}`,
});

export default defineScenario({
	name: "a switched pooled account opens one slot then ramps one slot each quarter second",
	config: {
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
			admission_cap: 3,
			admission_queue_limit: 3,
			admission_wait_ms: 1_000,
		},
	},
	fleet: [
		{ name: "a", accountUuid: "acct-a" },
		{ name: "b", accountUuid: "acct-b" },
	],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 429,
			headers: {
				"anthropic-ratelimit-unified-reset": at("1h"),
				"anthropic-ratelimit-unified-status": "rejected",
			},
			json: { type: "error" },
			times: 1,
		},
		{
			id: "first-b-response",
			account: "b",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
			times: 1,
			hold: { received: 1, release: "manual" },
		},
		{
			id: "second-b-response",
			account: "b",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
			times: 1,
			hold: { received: 1, release: "manual" },
		},
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{
			type: "request",
			id: "first",
			waitForCompletion: false,
			waitForUpstream: 2,
			...request("first"),
		},
		{
			type: "request",
			id: "second",
			waitForCompletion: false,
			...request("second"),
		},
		{
			type: "request",
			id: "third",
			waitForCompletion: false,
			...request("third"),
		},
		{ type: "flush" },
		{ type: "release", id: "first-b-response" },
		{ type: "await", id: "first" },
		{ type: "wait-for-upstream", count: 3 },
		{ type: "advance", by: "250ms" },
		{ type: "wait-for-upstream", count: 4 },
		{ type: "release", id: "second-b-response" },
		{ type: "await", id: "second" },
		{ type: "await", id: "third" },
	],
	assertions: [
		{
			id: "only-one-switched-request-reaches-b-before-first-response-finishes",
			type: "upstream",
			count: 4,
			accounts: ["a", "b", "b", "b"],
			neverWhileHold: "first-b-response",
		},
		{ id: "storm-clients-succeed", type: "client", statuses: [200, 200, 200] },
	],
	upstreamTest: "teamclaude/test/storm-control.test.js",
});
