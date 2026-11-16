import {
	confirm,
	enrollmentConfig,
	enrollmentEnvironment,
	profileReply,
	readAccounts,
	readRouting,
	requestEmail,
	start,
	tokenReply,
	verify,
} from "./harness/enrollment-fixture";
import { defineScenario, type FleetAccount } from "./harness/scenario";

const seats = [
	{ name: "owner", errorReason: "OAuth refresh was rejected by the upstream" },
	{ name: "missing", errorReason: "missing OAuth refresh token" },
	{ name: "manual", paused: true },
	{ name: "unknown", errorReason: "Operator investigation required" },
	{
		name: "custom-label",
		enrollmentContact: { email: "excluded@example.test" },
		paused: true,
	},
];
const names = ["owner", "missing", "manual", "unknown", "excluded"];
const fleet: FleetAccount[] = seats.map((seat, index) => ({
	...seat,
	accountUuid: `seat-${names[index]}`,
	organizationUuid: "synthetic-org",
	priority: 8,
	usageCount: 3,
	quotaState: {
		windows: {
			unified5h: {
				utilization: 0.4,
				seenAt: 1_700_000_000_000,
				resetAt: 1_700_018_000_000,
				status: "allowed",
			},
		},
	},
}));
const allowlist = names.slice(0, 4).map((name) => `seat-${name}`);

export default defineScenario({
	name: "enrollment reconnect refreshes one saved account while preserving operator policy and quota",
	environment: enrollmentEnvironment,
	config: {
		...enrollmentConfig,
		enrollment_emails: names.map((name) => `${name}@example.test`),
		team_routing: {
			...enrollmentConfig.team_routing,
			allowlisted_account_uuids: allowlist,
		},
	},
	claudeOAuth: true,
	fleet,
	upstream: [
		tokenReply,
		...names.map((name) => ({
			...profileReply({ uuid: `seat-${name}`, email: `${name}@example.test` }),
			times: 1,
		})),
		{ path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{ ...readAccounts("before"), capture: { ownerId: { field: "0.id" } } },
		...names.flatMap((name) => [
			requestEmail(name, `${name}@example.test`),
			start(name),
			verify(name),
			confirm(name),
		]),
		{
			type: "request",
			id: "sameId",
			method: "PATCH",
			path: "/api/accounts/{{ownerId}}",
			headers: { "x-api-key": "scenario-admin-key" },
			body: '{"priority":8}',
		},
		readAccounts("after"),
		readRouting("routing"),
		{ type: "restart" },
		readAccounts("persisted"),
		{ ...readAccounts("status"), path: "/api/status" },
		{
			type: "request",
			id: "inference",
			headers: { "x-api-key": "scenario-proxy-key" },
			body: "{}",
		},
	],
	assertions: [
		...names.map((name) => ({
			id: `${name}-reconnected`,
			type: "client" as const,
			request: `${name}-confirm`,
			status: 200,
			jsonPath: { path: "reconnected", value: true },
		})),
		...names.flatMap((name, index) => [
			{
				id: `${name}-reports-pause-policy`,
				type: "client" as const,
				request: `${name}-confirm`,
				jsonPath: { path: "paused", value: index >= 2 },
			},
			{
				id: `${name}-reports-inclusion-policy`,
				type: "client" as const,
				request: `${name}-confirm`,
				jsonPath: { path: "inPool", value: index < 4 },
			},
		]),
		{ id: "same-account-id", type: "client", request: "sameId", status: 200 },
		{
			id: "no-duplicate-accounts",
			type: "client",
			request: "after",
			jsonPath: { path: "length", value: 5 },
		},
		...["after", "persisted"].flatMap((request) =>
			seats.flatMap((seat, index) => [
				{
					id: `${request}-${seat.name}-pause`,
					type: "client" as const,
					request,
					jsonPath: { path: `${index}.paused`, value: index >= 2 },
				},
				{
					id: `${request}-${seat.name}-counters`,
					type: "client" as const,
					request,
					jsonPath: { path: `${index}.totalRequests`, value: 3 },
				},
			]),
		),
		{
			id: "unknown-pause-reason-preserved",
			type: "client",
			request: "after",
			jsonPath: { path: "3.errorReason", value: seats[3]?.errorReason },
		},
		{
			id: "saved-contact-keeps-operator-label",
			type: "client",
			request: "after",
			jsonPath: { path: "4.name", value: "custom-label" },
		},
		{
			id: "excluded-seat-not-readmitted",
			type: "client",
			request: "routing",
			jsonPath: { path: "allowlistedAccountUuids", value: allowlist },
		},
		{
			id: "quota-not-reset-by-login",
			type: "client",
			request: "status",
			jsonPath: {
				path: "accounts.0.quotaWindows.unified5h.utilization",
				value: 0.4,
			},
		},
		{
			id: "fresh-credentials-serve-inference",
			type: "client",
			request: "inference",
			status: 200,
		},
		{
			id: "upstream-gets-refreshed-token",
			type: "upstream",
			onPath: "/v1/messages",
			count: 1,
			header: { name: "authorization", value: "Bearer synthetic-access" },
		},
		{ id: "one-verification-per-seat", type: "upstream", count: 11 },
	],
});
