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
	name: "enrollment reconnect cannot be overwritten by a successful refresh from the previous authorization",
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
			...tokenReply,
			id: "old-refresh",
			times: 1,
			json: {
				access_token: "superseded-access",
				refresh_token: "superseded-refresh",
				expires_in: 3600,
			},
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
			id: "new-login-stays-unpaused",
			type: "client",
			request: "afterOldRefresh",
			jsonPath: { path: "0.paused", value: false },
		},
		{
			id: "new-credentials-remain-usable",
			type: "client",
			request: "afterReconnect",
			status: 200,
		},
		{
			id: "old-refresh-never-overwrites-new-token",
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
