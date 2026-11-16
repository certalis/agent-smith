import {
	enrollmentConfig,
	enrollmentEnvironment,
	publicHeaders,
	readAccounts,
	requestEmail,
} from "./harness/enrollment-fixture";
import { defineScenario, type RequestStep } from "./harness/scenario";

const resume = (id: string): RequestStep => ({
	type: "request",
	id,
	path: "/pool-enroll/resume",
	body: "{}",
	headers: { ...publicHeaders, cookie: "{{browserCookie}}" },
});
const begin = (id: string): RequestStep => ({
	...requestEmail(id, "owner@example.test"),
	capture: { browserCookie: { header: "set-cookie" } },
});

export default defineScenario({
	name: "enrollment browser recovery expires with its step and is revoked by process restart",
	environment: enrollmentEnvironment,
	config: { ...enrollmentConfig, enrollment_emails: ["owner@example.test"] },
	fleet: [],
	upstream: [],
	steps: [
		{ ...resume("withoutCookie"), headers: publicHeaders },
		begin("first"),
		{ type: "advance", by: "10m" },
		resume("expired"),
		begin("second"),
		resume("fresh"),
		{ type: "restart" },
		resume("afterRestart"),
		{ ...resume("resetMissing"), path: "/pool-enroll/reset" },
		readAccounts("accounts"),
	],
	assertions: [
		...["withoutCookie", "expired", "afterRestart"].map((request) => ({
			id: `${request}-no-recovery`,
			type: "client" as const,
			request,
			status: 410,
		})),
		{ id: "fresh-cookie-works", type: "client", request: "fresh", status: 200 },
		{
			id: "reset-is-idempotent",
			type: "client",
			request: "resetMissing",
			status: 200,
		},
		{
			id: "expired-flows-never-create-account",
			type: "client",
			request: "accounts",
			body: "[]",
		},
		{ id: "recovery-never-calls-provider", type: "upstream", count: 0 },
	],
});
