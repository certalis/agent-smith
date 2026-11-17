import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const body = (opening: string) =>
	JSON.stringify({
		model: "claude-opus-4-5",
		messages: [{ role: "user", content: opening }],
	});
const window = (utilization: number, resetIn: number) => ({
	utilization,
	resetAt: now + resetIn,
	seenAt: now,
	status: "allowed" as const,
});
const allowlist = ["low", "weekly", "five-hour", "later-tier"];

export default defineScenario({
	name: "expiry routing is opt-in and only changes new pins within the best priority tier",
	config: {
		team_routing: {
			enabled: true,
			quota_probe_seconds: 0,
			allowlisted_account_uuids: allowlist,
		},
	},
	environment: { AGENT_SMITH_ADMIN_KEY: "scenario-admin-key" },
	fleet: [
		{
			name: "low",
			accountUuid: "low",
			quotaState: {
				windows: {
					unified5h: window(0.1, 18_000_000),
					unified7d: window(0.1, 604_800_000),
				},
			},
		},
		{
			name: "weekly",
			accountUuid: "weekly",
			quotaState: {
				windows: {
					unified5h: window(0.5, 18_000_000),
					unified7d: window(0.5, 1_200_000),
				},
			},
		},
		{
			name: "five-hour",
			accountUuid: "five-hour",
			quotaState: { windows: { unified5h: window(0.6, 1_800_000) } },
		},
		{
			name: "later-tier",
			accountUuid: "later-tier",
			priority: 1,
			quotaState: { windows: { unified5h: window(0.2, 60_000) } },
		},
	],
	upstream: [{ path: "/v1/messages", status: 200, json: { ok: true } }],
	steps: [
		{ type: "request", body: body("ordinary default"), sessionId: "default" },
		{
			type: "request",
			id: "enable",
			path: "/api/config/team-routing",
			headers: { "x-api-key": "scenario-admin-key" },
			body: JSON.stringify({
				enabled: true,
				prefer_expiring_quota: true,
				allowlisted_account_uuids: allowlist,
			}),
		},
		{ type: "request", body: body("ordinary default"), sessionId: "default" },
		{ type: "request", body: body("new opening"), sessionId: "new" },
		{
			type: "request",
			path: "/tc-acct/low/v1/claude-code/v1/messages",
			body: body("manual opening"),
			sessionId: "manual",
		},
		{ type: "advance", by: "21m" },
		{
			type: "request",
			body: body("after the weekly reset"),
			sessionId: "five-hour-opening",
		},
	],
	assertions: [
		{
			id: "expiry-policy-can-be-enabled",
			type: "client",
			request: "enable",
			status: 200,
		},
		{
			id: "existing-and-manual-pins-stay-while-earliest-reset-wins-new-pin",
			type: "upstream",
			count: 5,
			accounts: ["low", "low", "weekly", "low", "five-hour"],
		},
		{ id: "all-routing-requests-succeed", type: "client", status: 200 },
	],
});
