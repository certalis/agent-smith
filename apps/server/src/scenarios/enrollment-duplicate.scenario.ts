import {
	enrollmentEnvironment,
	issue,
	oauthReplies,
	readAccounts,
	start,
	verify,
} from "./harness/enrollment-fixture";
import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "private enrollment cannot replace an existing provider identity or its credentials",
	environment: enrollmentEnvironment,
	claudeOAuth: true,
	fleet: [{ name: "existing", accountUuid: "verified-seat" }],
	upstream: [
		...oauthReplies,
		{
			account: "existing",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
		},
	],
	steps: [
		issue("duplicate"),
		start("duplicate"),
		verify("duplicate", false),
		readAccounts("accounts"),
		{
			type: "request",
			id: "inference",
			headers: { "x-api-key": "scenario-proxy-key" },
			body: "{}",
		},
	],
	assertions: [
		{
			id: "duplicate-identity-rejected",
			type: "client",
			request: "duplicate-verify",
			status: 409,
		},
		{
			id: "exactly-existing-account-remains",
			type: "client",
			request: "accounts",
			jsonPath: { path: "length", value: 1 },
		},
		{
			id: "existing-account-unchanged",
			type: "client",
			request: "accounts",
			jsonPath: { path: "0.name", value: "existing" },
		},
		{
			id: "existing-auth-still-works",
			type: "client",
			request: "inference",
			status: 200,
		},
		{
			id: "upstream-received-original-seat-token",
			type: "upstream",
			atLeastAccount: { name: "existing", count: 1 },
			count: 3,
		},
	],
});
