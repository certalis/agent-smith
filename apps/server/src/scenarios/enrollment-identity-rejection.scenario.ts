import {
	enrollmentConfig,
	enrollmentEnvironment,
	issue,
	profileReply,
	readAccounts,
	readRouting,
	start,
	tokenReply,
	verify,
} from "./harness/enrollment-fixture";
import { defineScenario } from "./harness/scenario";

const kinds = ["email", "display", "identity", "tokens", "state"];
export default defineScenario({
	name: "private enrollment rejects mismatched email and incomplete provider identity tokens or state",
	environment: enrollmentEnvironment,
	config: enrollmentConfig,
	claudeOAuth: true,
	fleet: [],
	upstream: [
		{ ...tokenReply, times: 3 },
		{
			...tokenReply,
			json: {
				access_token: "synthetic-access",
				refresh_token: "synthetic-refresh",
				expires_in: 0,
			},
		},
		{ ...profileReply(), times: 1 },
		{ ...profileReply({ uuid: "verified-seat", email: "" }), times: 1 },
		{ ...profileReply({ uuid: "", email: "owner@example.test" }), times: 1 },
		profileReply(),
	],
	steps: [
		...kinds.flatMap((kind) => [
			issue(kind, kind === "email" ? { email: "different@example.test" } : {}),
			start(kind),
			{
				...verify(kind, false),
				...(kind === "state"
					? {
							body: '{"token":"{{stateFlow}}","code":"synthetic-code#wrong-state"}',
						}
					: {}),
			},
		]),
		readAccounts("accounts"),
		readRouting("routing"),
	],
	assertions: [
		...kinds.map((kind) => ({
			id: `${kind}-rejected`,
			type: "client" as const,
			request: `${kind}-verify`,
			status: 400,
		})),
		{
			id: "no-accounts-saved",
			type: "client",
			request: "accounts",
			body: "[]",
		},
		{
			id: "allowlist-unchanged",
			type: "client",
			request: "routing",
			jsonPath: { path: "allowlistedAccountUuids", value: ["existing-seat"] },
		},
		{
			id: "mismatch-does-not-disclose-restriction",
			type: "client",
			request: "email-verify",
			bodyExcludes: ["different@example.test", "owner@example.test"],
		},
		{ id: "state-rejected-before-provider", type: "upstream", count: 8 },
	],
});
