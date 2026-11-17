import { defineScenario } from "./harness/scenario";

const now = 1_700_000_000_000;
const window = (utilization: number | null, resetIn: number, seenAt = now) => ({
	utilization,
	resetAt: now + resetIn,
	seenAt,
	status: "allowed" as const,
});
const seats = [
	"ordinary",
	"stale",
	"reset",
	"irrelevant",
	"unknown",
	"distant",
	"spent",
	"paused",
];

export default defineScenario({
	name: "expiry urgency ignores stale reset irrelevant unknown and out-of-horizon windows and preserves seat exclusions",
	config: {
		team_routing: {
			enabled: true,
			prefer_expiring_quota: true,
			quota_probe_seconds: 0,
			allowlisted_account_uuids: seats,
		},
	},
	fleet: [
		{
			name: "ordinary",
			accountUuid: "ordinary",
			quotaState: {
				windows: {
					unified5h: window(0, 18_000_000),
					unified7d: window(0, 604_800_000),
				},
			},
		},
		{
			name: "stale",
			accountUuid: "stale",
			quotaState: {
				windows: { unified5h: window(0.8, 60_000, now - 1_800_001) },
			},
		},
		{
			name: "reset",
			accountUuid: "reset",
			quotaState: {
				windows: {
					unified5h: window(0.8, -1),
					unified7d: window(0.8, 604_800_000),
				},
			},
		},
		{
			name: "irrelevant",
			accountUuid: "irrelevant",
			quotaState: {
				windows: {
					unified5h: window(0.8, 18_000_000),
					unified7dFable: window(0.8, 120_000),
				},
			},
		},
		{
			name: "unknown",
			accountUuid: "unknown",
			quotaState: {
				windows: {
					unified5h: window(0.8, 18_000_000),
					unified7d: window(null, 180_000),
				},
			},
		},
		{
			name: "distant",
			accountUuid: "distant",
			quotaState: {
				windows: {
					unified5h: window(0.8, 3_600_001),
					unified7d: window(0.8, 86_400_001),
				},
			},
		},
		{
			name: "spent",
			accountUuid: "spent",
			quotaState: { windows: { unified5h: window(0.9, 240_000) } },
		},
		{
			name: "paused",
			accountUuid: "paused",
			paused: true,
			quotaState: { windows: { unified5h: window(0.1, 1) } },
		},
		{
			name: "protected",
			accountUuid: "protected",
			quotaState: { windows: { unified5h: window(0.1, 1) } },
		},
	],
	upstream: [{ path: "/v1/messages", status: 200, json: { ok: true } }],
	steps: [
		{
			type: "request",
			sessionId: "fresh-chat",
			body: '{"model":"claude-opus-4-5","messages":[{"role":"user","content":"an ordinary opening"}]}',
		},
	],
	assertions: [
		{
			id: "only-an-eligible-applicable-fresh-window-can-create-urgency",
			type: "upstream",
			count: 1,
			accounts: ["ordinary"],
		},
		{ id: "client-succeeds", type: "client", status: 200 },
	],
});
