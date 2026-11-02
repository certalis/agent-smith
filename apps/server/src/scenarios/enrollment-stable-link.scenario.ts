import {
	confirm,
	enrollmentConfig,
	enrollmentEnvironment,
	oauthReplies,
	publicHeaders,
	readAccounts,
	start,
	verify,
} from "./harness/enrollment-fixture";
import type { RequestStep } from "./harness/scenario";
import { defineScenario } from "./harness/scenario";

function request(id: string, email: string, capture = false): RequestStep {
	return {
		type: "request",
		id,
		path: "/pool-enroll/request",
		headers: publicHeaders,
		body: JSON.stringify({ email }),
		...(capture ? { capture: { [`${id}Invite`]: { field: "token" } } } : {}),
	};
}
function emails(id: string, body: object, key = "scenario-admin-key") {
	return {
		type: "request" as const,
		id,
		path: "/api/enrollment-emails",
		headers: { "x-api-key": key },
		body: JSON.stringify(body),
	};
}

export default defineScenario({
	name: "stable enrollment link admits only listed emails and still requires the matching Claude identity",
	environment: enrollmentEnvironment,
	config: {
		...enrollmentConfig,
		enrollment_emails: ["Owner@Example.test ", "other@example.test"],
	},
	claudeOAuth: true,
	fleet: [],
	upstream: oauthReplies,
	steps: [
		request("stranger", "stranger@example.test"),
		request("owner", " OWNER@example.test ", true),
		start("owner"),
		verify("owner"),
		confirm("owner"),
		readAccounts("accounts"),
		request("again", "owner@example.test"),
		request("other", "other@example.test", true),
		start("other"),
		verify("other", false),
		emails("proxyRead", {}, "scenario-proxy-key"),
		{ ...emails("proxyGet", {}, "scenario-proxy-key"), method: "GET" },
		emails("invalidAdd", { add: ["not-an-email"] }),
		emails("unknownField", { replace: [] }),
		emails("remove", { remove: ["OTHER@example.test"] }),
		request("removed", "other@example.test"),
		{ type: "restart" },
		emails("afterRestart", {}),
		emails("add", { add: ["New@example.test"] }),
	],
	assertions: [
		{
			id: "unlisted-email-refused",
			type: "client",
			request: "stranger",
			status: 403,
		},
		{
			id: "listed-email-normalized",
			type: "client",
			request: "owner",
			status: 200,
			jsonPath: { path: "email", value: "owner@example.test" },
		},
		{
			id: "matching-identity-connects",
			type: "client",
			request: "owner-confirm",
			jsonPath: { path: "connected", value: true },
		},
		{
			id: "seat-named-after-local-part",
			type: "client",
			request: "accounts",
			jsonPath: { path: "0.name", value: "owner" },
		},
		{
			id: "connected-email-cannot-request-twice",
			type: "client",
			request: "again",
			status: 409,
		},
		{
			id: "listed-email-still-needs-matching-identity",
			type: "client",
			request: "other-verify",
			status: 400,
		},
		{
			id: "proxy-key-cannot-read-list",
			type: "client",
			request: "proxyRead",
			status: 401,
		},
		{
			id: "invalid-email-refuses-whole-edit",
			type: "client",
			request: "invalidAdd",
			status: 400,
		},
		{
			id: "unknown-edit-field-refused",
			type: "client",
			request: "unknownField",
			status: 400,
		},
		{
			id: "removal-applies-case-insensitively",
			type: "client",
			request: "remove",
			jsonPath: { path: "emails", value: ["owner@example.test"] },
		},
		{
			id: "removal-is-live",
			type: "client",
			request: "removed",
			status: 403,
		},
		{
			id: "list-persists-across-restart",
			type: "client",
			request: "afterRestart",
			jsonPath: { path: "emails", value: ["owner@example.test"] },
		},
		{
			id: "admin-adds-normalized",
			type: "client",
			request: "add",
			jsonPath: {
				path: "emails",
				value: ["owner@example.test", "new@example.test"],
			},
		},
		{
			id: "public-responses-never-list-emails",
			type: "client",
			request: "stranger",
			bodyExcludes: ["owner@example.test", "other@example.test"],
		},
		{
			id: "proxy-responses-never-list-emails",
			type: "client",
			request: "proxyGet",
			bodyExcludes: ["owner@example.test", "other@example.test"],
		},
		{ id: "two-flows-reach-claude", type: "upstream", count: 4 },
	],
});
