import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const reset = now + 3_600_000;
const model = "claude-sonnet-4-5";
const body = JSON.stringify({ model, messages: [] });
const path = `/api/pool-status?provider=claude-code&model=${model}`;

export default defineScenario({
	name: "weekly cap applies to model families, prevents stale revalidation and reopens at reset",
	config: {
		block_when_all_full: false,
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["tech"],
			weekly_max_usage: 0.3,
		},
	},
	fleet: [
		{
			name: "tech",
			accountUuid: "tech",
			tokenExpiresIn: "3h",
			enrollmentContact: { email: "tech@example.test" },
			quotaState: {
				windows: {
					unified7dSonnet: {
						resetAt: reset,
						seenAt: now,
						status: "allowed",
						utilization: 0.299,
					},
				},
			},
		},
	],
	upstream: [
		{
			account: "tech",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
			headers: {
				"anthropic-ratelimit-unified-7d_sonnet-status": "allowed",
				"anthropic-ratelimit-unified-7d_sonnet-utilization": "0.3",
				"anthropic-ratelimit-unified-7d_sonnet-reset": String(reset / 1_000),
			},
		},
		{
			account: "tech",
			path: "/v1/messages",
			status: 200,
			times: 2,
			json: { ok: true },
		},
	],
	steps: [
		{ type: "request", id: "below", body },
		{ type: "advance", by: "30m" },
		{ type: "advance", by: "1ms" },
		{ type: "request", id: "stale", body },
		{ type: "request", id: "probe", body },
		{ type: "request", id: "blocked-status", method: "GET", path, body: "" },
		{
			type: "request",
			id: "other-family",
			body: '{"model":"claude-opus-4-5","messages":[]}',
		},
		{ type: "advance", by: "30m" },
		{ type: "request", id: "open-status", method: "GET", path, body: "" },
		{ type: "request", id: "reopened", body },
	],
	assertions: [
		{
			id: "model-cap-and-reset-preserve-other-families",
			type: "client",
			statuses: [200, 429, 429, 200, 200, 200, 200],
		},
		{
			id: "stale-reading-retains-hard-cap",
			type: "client",
			request: "stale",
			header: { name: "retry-after", value: "1800" },
		},
		{
			id: "status-has-no-eligible-seat",
			type: "client",
			request: "blocked-status",
			jsonPath: { path: "eligibleAccounts", value: 0 },
		},
		{
			id: "status-and-retry-use-the-same-reset",
			type: "client",
			request: "blocked-status",
			jsonPath: { path: "retryAtMs", value: reset },
		},
		{
			id: "reset-restores-status",
			type: "client",
			request: "open-status",
			jsonPath: { path: "eligibleAccounts", value: 1 },
		},
		{ id: "only-eligible-requests-reach-provider", type: "upstream", count: 3 },
	],
});
