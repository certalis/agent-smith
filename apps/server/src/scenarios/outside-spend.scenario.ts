import { at, defineScenario } from "./harness/scenario";

const body = (opening: string) =>
	JSON.stringify({
		model: "claude-opus-4-5",
		messages: [{ role: "user", content: opening }],
	});

export default defineScenario({
	name: "status reports a served weekly rise as not measurable rather than outside spend",
	config: {
		team_routing: { enabled: true, allowlisted_account_uuids: ["acct-a"] },
	},
	fleet: [{ name: "a", accountUuid: "acct-a" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
			times: 1,
			headers: {
				"anthropic-ratelimit-unified-7d-utilization": "0.30",
				"anthropic-ratelimit-unified-7d-reset": at("1h"),
			},
		},
		{
			account: "a",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
			headers: {
				"anthropic-ratelimit-unified-7d-utilization": "0.40",
				"anthropic-ratelimit-unified-7d-reset": at("1h"),
			},
		},
	],
	steps: [
		{ type: "request", body: body("first"), sessionId: "outside-one" },
		{ type: "request", body: body("second"), sessionId: "outside-two" },
		{ type: "flush" },
		{ type: "request", method: "GET", path: "/api/status", body: "" },
	],
	assertions: [
		{
			id: "served-interval-is-not-falsely-counted",
			type: "client",
			index: 2,
			status: 200,
			bodyIncludes: "not_measurable",
		},
	],
	upstreamTest: "teamclaude/test/outside-spend.test.js",
});
