import { at, defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;

export default defineScenario({
	name: "an API-key 401 is cooled down instead of relayed to the client",
	fleet: [{ name: "bad-key", authMethod: "api_key" }],
	upstream: [
		{
			path: "/v1/messages",
			status: 401,
			json: { type: "error" },
			times: 1,
		},
		{ path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{ type: "request", body },
		{
			type: "assert",
			assertions: [
				{
					id: "api-key-cooldown-is-exactly-five-minutes",
					type: "account",
					limited: "bad-key",
					limitedUntil: at("5m"),
				},
			],
		},
		{ type: "advance", by: "5m" },
		{ type: "advance", by: "1ms" },
		{ type: "request", body },
	],
	assertions: [
		{
			id: "cooldown-expires-and-the-account-is-retried",
			type: "upstream",
			count: 2,
			bodyIdentical: [body, body],
		},
		{
			id: "first-response-hides-upstream-401-and-second-succeeds",
			type: "client",
			statuses: [503, 200],
		},
		{
			id: "cooldown-is-cleared-after-five-minutes",
			type: "account",
			notLimited: "bad-key",
		},
	],
	upstreamTest: "teamclaude/test/server-401.test.js",
});
