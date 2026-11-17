import {
	confirm,
	enrollmentConfig,
	enrollmentEnvironment,
	oauthReplies,
	readAccounts,
	requestEmail,
	start,
	verify,
} from "./harness/enrollment-fixture";
import { defineScenario } from "./harness/scenario";

const denied = [
	"not-an-email",
	"owner@@example.test",
	"*@example.test",
	"owner@sub.example.test",
	"owner@notexample.test",
	"owner@example.test.evil",
];
const request = (id: string, email: string) => ({
	...requestEmail(id, email),
	capture: undefined,
});

export default defineScenario({
	name: "enrollment domain rules admit exact-domain emails without weakening identity binding or revocation",
	environment: enrollmentEnvironment,
	config: {
		...enrollmentConfig,
		enrollment_emails: [" *@EXAMPLE.test ", "guest@external.example.test"],
	},
	claudeOAuth: true,
	fleet: [],
	upstream: oauthReplies,
	steps: [
		...denied.map((email, index) => request(`denied-${index}`, email)),
		requestEmail("owner", " OWNER@EXAMPLE.test "),
		start("owner"),
		verify("owner"),
		confirm("owner"),
		requestEmail("other", "other@example.test"),
		start("other"),
		verify("other", false),
		readAccounts("accounts"),
		{
			type: "request",
			id: "remove",
			path: "/api/enrollment-emails",
			headers: { "x-api-key": "scenario-admin-key" },
			body: JSON.stringify({ remove: [" *@Example.test "] }),
		},
		request("removedLive", "new@example.test"),
		{ type: "restart" },
		request("removedPersisted", "new@example.test"),
		request("explicitExternal", " GUEST@EXTERNAL.example.test "),
		request("externalOther", "other@external.example.test"),
	],
	assertions: [
		...denied.map((_, index) => ({
			id: `invalid-or-other-domain-${index}-refused`,
			type: "client" as const,
			request: `denied-${index}`,
			status: 403,
		})),
		{
			id: "unlisted-local-part-admitted-and-normalized",
			type: "client",
			request: "owner",
			status: 200,
			jsonPath: { path: "email", value: "owner@example.test" },
		},
		{
			id: "matching-provider-identity-connects",
			type: "client",
			request: "owner-confirm",
			status: 200,
			jsonPath: { path: "connected", value: true },
		},
		{
			id: "same-domain-does-not-replace-exact-identity-binding",
			type: "client",
			request: "other-verify",
			status: 400,
		},
		{
			id: "identity-mismatch-never-adds-a-seat",
			type: "client",
			request: "accounts",
			jsonPath: { path: "length", value: 1 },
		},
		{
			id: "admin-removes-normalized-domain-rule",
			type: "client",
			request: "remove",
			status: 200,
			jsonPath: { path: "emails", value: ["guest@external.example.test"] },
		},
		...(["removedLive", "removedPersisted"] as const).map((id) => ({
			id: `${id}-refuses-new-invitations`,
			type: "client" as const,
			request: id,
			status: 403,
		})),
		{
			id: "explicit-other-domain-email-still-admitted",
			type: "client",
			request: "explicitExternal",
			status: 200,
		},
		{
			id: "individual-email-remains-exact",
			type: "client",
			request: "externalOther",
			status: 403,
		},
		{ id: "only-eligible-flows-reach-fake-oauth", type: "upstream", count: 4 },
	],
});
