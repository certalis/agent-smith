import { defineScenario } from "./harness/scenario";
import {
	standaloneRequest,
	standaloneWire,
	wireAdminKey,
	wireProxyKey,
} from "./harness/wire-fixture";

const now = 1_700_000_000_000;
const oneWeek = 7 * 24 * 60 * 60 * 1_000;
const fiveHours = 5 * 60 * 60 * 1_000;

const window = (resetAt: number, utilization: number) => ({
	resetAt,
	seenAt: now,
	status: "allowed",
	utilization,
});

const body = (topic: string) =>
	JSON.stringify({
		model: "claude-opus-4-5",
		messages: [{ role: "user", content: topic }],
	});

export default defineScenario({
	...standaloneWire,
	name: "a caller-specific weekly ceiling skips only that caller's full seat",
	config: {
		provider_pools: { "anthropic-messages": ["claude-code"] },
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a", "acct-b"],
			max_usage: 0.9,
			weekly_max_usage: 0.95,
		},
	},
	fleet: [
		{
			name: "a",
			accountUuid: "acct-a",
			quotaState: {
				windows: {
					unified5h: window(now + fiveHours, 0.1),
					unified7d: window(now + oneWeek, 0.7),
				},
			},
		},
		{
			name: "b",
			accountUuid: "acct-b",
			quotaState: {
				windows: {
					unified5h: window(now + fiveHours, 0.2),
					unified7d: window(now + oneWeek, 0.69),
				},
			},
		},
	],
	upstream: [
		{ account: "a", path: "/v1/messages", status: 200, json: { ok: true } },
		{ account: "b", path: "/v1/messages", status: 200, json: { ok: true } },
		{ account: "a", path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{
			...standaloneRequest,
			id: "before-policy",
			body: body(
				"Before the administrator sets Alice's lower ceiling, the lowest 5h seat is eligible",
			),
			sessionId: "before-policy",
		},
		{
			type: "request",
			transport: "unix",
			id: "set-alice-policy",
			method: "POST",
			path: "/api/config/team-routing",
			headers: {
				"content-type": "application/json",
				"x-api-key": wireAdminKey,
			},
			body: JSON.stringify({
				enabled: true,
				allowlisted_account_uuids: ["acct-a", "acct-b"],
				max_usage: 0.9,
				weekly_max_usage: 0.95,
				caller_weekly_max_usage: { "synthetic-device": 0.7 },
			}),
		},
		{
			type: "request",
			transport: "unix",
			id: "policy",
			method: "GET",
			path: "/api/config/team-routing",
			headers: { "x-api-key": wireProxyKey },
			body: "",
		},
		{
			...standaloneRequest,
			id: "alice-after-policy",
			body: body("Alice must not receive a seventy-percent seat"),
			sessionId: "alice-session",
		},
		{
			type: "request",
			transport: "unix",
			id: "default",
			path: "/v1/pool/anthropic-messages/v1/messages",
			headers: { "x-api-key": wireProxyKey },
			body: body("The default ceiling can still use that seat"),
			sessionId: "default-session",
		},
	],
	assertions: [
		{
			id: "policy-updates-live",
			type: "client",
			request: "set-alice-policy",
			status: 200,
			bodyExcludes: ["caller_weekly_max_usage", "synthetic-device"],
		},
		{
			id: "caller-policy-stays-private",
			type: "client",
			request: "policy",
			status: 200,
			bodyExcludes: ["caller_weekly_max_usage", "synthetic-device"],
		},
		{
			id: "caller-cap-skips-only-for-alice",
			type: "upstream",
			accounts: ["a", "b", "a"],
		},
		{ id: "both-callers-succeed", type: "client", status: 200 },
	],
});
