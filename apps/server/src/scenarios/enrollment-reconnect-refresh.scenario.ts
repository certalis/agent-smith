import {
	confirm,
	enrollmentConfig,
	enrollmentEnvironment,
	profileReply,
	readAccounts,
	requestEmail,
	start,
	tokenReply,
	verify,
} from "./harness/enrollment-fixture";
import { defineScenario, type RequestStep } from "./harness/scenario";

const inference = (id: string): RequestStep => ({
	type: "request",
	id,
	headers: { "x-api-key": "scenario-proxy-key" },
	body: "{}",
});

export default defineScenario({
	name: "enrollment reconnect survives a rejected refresh from the previous authorization still in flight",
	environment: enrollmentEnvironment,
	config: { ...enrollmentConfig, enrollment_emails: ["owner@example.test"] },
	claudeOAuth: true,
	fleet: [
		{
			name: "owner",
			accountUuid: "verified-seat",
			organizationUuid: "synthetic-org",
			tokenExpiresIn: "0ms",
		},
	],
	upstream: [
		{
			id: "old-refresh",
			path: "/v1/oauth/token",
			times: 1,
			status: 401,
			json: { error: "invalid_grant" },
			hold: { received: 1, release: "manual" },
		},
		tokenReply,
		profileReply(),
		{ path: "/v1/messages", status: 200, json: { ok: true } },
	],
	steps: [
		{ ...inference("pending"), waitForCompletion: false, waitForUpstream: 1 },
		requestEmail("fresh", "owner@example.test"),
		start("fresh"),
		verify("fresh"),
		confirm("fresh"),
		{ type: "release", id: "old-refresh" },
		{ type: "await", id: "pending" },
		readAccounts("afterOldRefresh"),
		inference("afterReconnect"),
	],
	assertions: [
		{
			id: "new-authorization-saved",
			type: "client",
			request: "fresh-confirm",
			status: 200,
		},
		{
			id: "stale-refresh-cannot-quarantine-new-login",
			type: "client",
			request: "afterOldRefresh",
			jsonPath: { path: "0.paused", value: false },
		},
		{
			id: "stale-refresh-does-not-record-login-error",
			type: "client",
			request: "afterOldRefresh",
			jsonPath: { path: "0.errorReason", value: null },
		},
		{
			id: "new-credentials-remain-usable",
			type: "client",
			request: "afterReconnect",
			status: 200,
		},
		{
			id: "only-new-token-serves-inference",
			type: "upstream",
			onPath: "/v1/messages",
			header: { name: "authorization", value: "Bearer synthetic-access" },
		},
		{
			id: "one-old-and-one-new-token-exchange",
			type: "upstream",
			onPath: "/v1/oauth/token",
			count: 2,
		},
	],
});
