import {
	confirm,
	disconnect,
	enrollmentConfig,
	enrollmentEnvironment,
	profileReply,
	publicHeaders,
	readAccounts,
	requestEmail,
	start,
	tokenReply,
	verify,
} from "./harness/enrollment-fixture";
import { defineScenario, type RequestStep } from "./harness/scenario";

const oldBrowser = (id: string): RequestStep => ({
	type: "request",
	id,
	path: "/pool-enroll/resume",
	headers: { ...publicHeaders, cookie: "{{oldCookie}}" },
	body: "{}",
});

export default defineScenario({
	name: "enrollment reconnect binds saved identity and revokes old disconnect only after successful consent",
	environment: enrollmentEnvironment,
	config: { ...enrollmentConfig, enrollment_emails: ["owner@example.test"] },
	claudeOAuth: true,
	fleet: [],
	upstream: [
		tokenReply,
		{ ...profileReply(), times: 1 },
		{
			...profileReply({ uuid: "different-seat", email: "owner@example.test" }),
			times: 1,
		},
		{ ...profileReply(undefined, "different-org"), times: 1 },
		profileReply(),
	],
	steps: [
		{
			...requestEmail("original", "owner@example.test"),
			capture: {
				originalInvite: { field: "token" },
				oldCookie: { header: "set-cookie" },
			},
		},
		...[start("original"), verify("original"), confirm("original", true)].map(
			(step) => ({
				...step,
				headers: { ...publicHeaders, cookie: "{{oldCookie}}" },
			}),
		),
		...["wrongUuid", "wrongOrg"].flatMap((id) => [
			requestEmail(id, "owner@example.test"),
			start(id),
			verify(id, false),
		]),
		oldBrowser("afterFailedIdentity"),
		requestEmail("fresh", "owner@example.test"),
		start("fresh"),
		verify("fresh"),
		oldBrowser("beforeConsent"),
		confirm("fresh", true),
		oldBrowser("afterConsent"),
		disconnect("original", "unused", false),
		readAccounts("stillPresent"),
		disconnect("fresh", "unused", false),
		readAccounts("removed"),
	],
	assertions: [
		...["wrongUuid", "wrongOrg"].map((id) => ({
			id: `${id}-rejected`,
			type: "client" as const,
			request: `${id}-verify`,
			status: 409,
		})),
		...["afterFailedIdentity", "beforeConsent"].map((request) => ({
			id: `${request}-old-authority-preserved`,
			type: "client" as const,
			request,
			status: 200,
			jsonPath: { path: "stage", value: "connected" },
		})),
		{
			id: "fresh-identity-consented",
			type: "client",
			request: "fresh-confirm",
			status: 200,
		},
		...["afterConsent", "original-disconnect"].map((request) => ({
			id: `${request}-old-authority-revoked`,
			type: "client" as const,
			request,
			status: 410,
		})),
		{
			id: "old-token-cannot-delete-reconnected-account",
			type: "client",
			request: "stillPresent",
			jsonPath: { path: "length", value: 1 },
		},
		{
			id: "fresh-owner-can-disconnect",
			type: "client",
			request: "fresh-disconnect",
			status: 200,
		},
		{
			id: "fresh-removal-succeeds",
			type: "client",
			request: "removed",
			body: "[]",
		},
		{ id: "four-verified-attempts-only", type: "upstream", count: 8 },
	],
});
