import {
	confirm,
	enrollmentConfig,
	enrollmentEnvironment,
	issue,
	oauthReplies,
	readAccounts,
	readRouting,
	start,
	verify,
} from "./harness/enrollment-fixture";
import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "private enrollment reports a config write failure and rolls back account credentials",
	environment: enrollmentEnvironment,
	config: enrollmentConfig,
	claudeOAuth: true,
	fleet: [],
	upstream: oauthReplies,
	steps: [
		issue("save"),
		start("save"),
		verify("save"),
		{ type: "block-config-write" },
		confirm("save"),
		readAccounts("accounts"),
		readRouting("routing"),
	],
	assertions: [
		{
			id: "cannot-claim-success",
			type: "client",
			request: "save-confirm",
			status: 500,
		},
		{
			id: "credentials-rolled-back",
			type: "client",
			request: "accounts",
			body: "[]",
		},
		{
			id: "no-in-memory-membership",
			type: "client",
			request: "routing",
			jsonPath: { path: "allowlistedAccountUuids", value: ["existing-seat"] },
		},
		{ id: "provider-called-only-for-verification", type: "upstream", count: 2 },
	],
});
