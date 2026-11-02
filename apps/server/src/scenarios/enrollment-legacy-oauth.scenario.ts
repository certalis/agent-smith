import {
	enrollmentEnvironment,
	oauthReplies,
	readAccounts,
} from "./harness/enrollment-fixture";
import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "private enrollment isolation preserves ordinary admin initiated OAuth callbacks",
	environment: enrollmentEnvironment,
	claudeOAuth: true,
	fleet: [],
	upstream: oauthReplies,
	steps: [
		{
			type: "request",
			path: "/api/auth/claude-code/init",
			headers: { "x-api-key": "scenario-admin-key" },
			body: '{"name":"ordinary-seat"}',
			capture: { state: { field: "data.authUrl", query: "state" } },
		},
		{ type: "restart" },
		{
			type: "request",
			id: "callback",
			method: "GET",
			path: "/oauth/claude-code/callback?state={{state}}&code=synthetic-code%23{{state}}",
			headers: { "x-api-key": "scenario-proxy-key" },
			body: "",
		},
		readAccounts("accounts"),
	],
	assertions: [
		{
			id: "ordinary-callback-still-supported",
			type: "client",
			request: "callback",
			status: 200,
		},
		{
			id: "ordinary-account-saved",
			type: "client",
			request: "accounts",
			jsonPath: { path: "0.name", value: "ordinary-seat" },
		},
		{ id: "provider-token-and-profile-called", type: "upstream", count: 2 },
	],
});
