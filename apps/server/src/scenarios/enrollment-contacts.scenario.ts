import {
	confirm,
	enrollmentEnvironment,
	issue,
	oauthReplies,
	readAccounts,
	start,
	verify,
} from "./harness/enrollment-fixture";
import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "private enrollment requires consent and accepts optional contacts without exposing them",
	environment: enrollmentEnvironment,
	claudeOAuth: true,
	fleet: [],
	upstream: oauthReplies,
	steps: [
		issue("declined"),
		start("declined"),
		verify("declined"),
		{
			...confirm("declined"),
			body: '{"token":"{{declinedConfirm}}","consent":false}',
		},
		readAccounts("beforeConsent"),
		issue("contacts", {
			name: "owner",
			email: "OWNER@example.test",
			contactEmail: "remind@example.test",
			slackUserId: "U0123456789",
		}),
		start("contacts"),
		verify("contacts"),
		confirm("contacts"),
		{ type: "restart" },
		readAccounts("afterRestart"),
		{ ...issue("taken", { name: "owner" }), capture: undefined },
	],
	assertions: [
		{
			id: "declined-consent-rejected",
			type: "client",
			request: "declined-confirm",
			status: 400,
		},
		{
			id: "declined-consent-stores-nothing",
			type: "client",
			request: "beforeConsent",
			body: "[]",
		},
		{
			id: "optional-details-accepted",
			type: "client",
			request: "contacts-confirm",
			status: 200,
		},
		{
			id: "durable-account-has-operator-label",
			type: "client",
			request: "afterRestart",
			jsonPath: { path: "0.name", value: "owner" },
		},
		{
			id: "cannot-overwrite-existing-label",
			type: "client",
			request: "taken",
			status: 409,
		},
		{
			id: "private-contact-not-exposed",
			type: "client",
			bodyExcludes: [
				"remind@example.test",
				"U0123456789",
				"synthetic-access",
				"synthetic-refresh",
			],
		},
		{ id: "two-verifications-only", type: "upstream", count: 4 },
	],
});
