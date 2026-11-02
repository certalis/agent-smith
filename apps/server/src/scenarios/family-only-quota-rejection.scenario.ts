import { defineScenario } from "./harness/scenario";

const fableBody = '{"model":"claude-fable-5-1","messages":[]}' as const;
const haikuBody = '{"model":"claude-haiku-4-5","messages":[]}' as const;

export default defineScenario({
	name: "a family-only quota rejection does not block another model family",
	fleet: [{ name: "a" }, { name: "b" }],
	upstream: [
		{
			account: "a",
			path: "/v1/messages",
			times: 1,
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-5h-utilization": "0.01",
				"anthropic-ratelimit-unified-5h-reset": "1700000360",
				"anthropic-ratelimit-unified-7d-status": "allowed",
				"anthropic-ratelimit-unified-7d-utilization": "0.52",
				"anthropic-ratelimit-unified-7d-reset": "1700000360",
				"anthropic-ratelimit-unified-7d_oi-status": "rejected",
				"anthropic-ratelimit-unified-7d_oi-utilization": "1.01",
				"anthropic-ratelimit-unified-7d_oi-reset": "1700000360",
			},
			json: { ok: true },
		},
		{ account: "a", path: "/v1/messages", status: 200, json: { ok: true } },
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", body: fableBody },
		{ type: "request", body: haikuBody },
		{ type: "request", body: fableBody },
	],
	assertions: [
		{
			id: "shared-model-stays-on-the-account",
			type: "upstream",
			count: 3,
			accounts: ["a", "a", "b"],
			bodyIdentical: [fableBody, haikuBody, fableBody],
		},
		{ id: "each-request-succeeds", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/unified-status-family.test.js",
});
