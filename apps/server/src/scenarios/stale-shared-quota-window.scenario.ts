import { defineScenario } from "./harness/scenario";

const body = '{"model":"claude-retired","messages":[]}' as const;

export default defineScenario({
	name: "a stale shared quota rejection no longer excludes its account",
	fleet: [
		{
			name: "stale-priority",
			priority: 0,
			quotaState: {
				windows: {
					unified5h: {
						resetAt: 1_700_003_600_000,
						seenAt: 1_700_000_000_000,
						status: "rejected",
						utilization: null,
					},
				},
			},
		},
		{ name: "fresh-fallback", priority: 1 },
	],
	upstream: [
		{
			account: "stale-priority",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
		},
	],
	steps: [
		{ type: "advance", by: "30m" },
		{ type: "advance", by: "1ms" },
		{ type: "request", body },
	],
	assertions: [
		{
			id: "stale-shared-status-does-not-exclude-the-account",
			type: "upstream",
			count: 1,
			accounts: ["stale-priority"],
			bodyIdentical: body,
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
	upstreamTest: "teamclaude/test/status-expired-windows.test.js",
});
