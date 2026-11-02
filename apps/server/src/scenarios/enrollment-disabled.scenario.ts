import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "private enrollment is absent without its origin opt-in",
	environment: {
		CF_ADMIN_KEY: "scenario-admin-key",
		CF_PROXY_KEY: "scenario-proxy-key",
		CF_TRUST_LOOPBACK: "false",
	},
	fleet: [],
	upstream: [],
	steps: [
		...[
			"/api/enrollment-invitations",
			"/pool-enroll/start",
			"/pool-enroll/verify",
			"/pool-enroll/confirm",
			"/pool-enroll/disconnect",
		].map((path) => ({
			type: "request" as const,
			path,
			body: "{}",
			headers: { "x-api-key": "scenario-admin-key" },
		})),
		{
			type: "request",
			method: "GET",
			path: "/pool-enroll",
			body: "",
			headers: { "x-api-key": "scenario-admin-key" },
		},
	],
	assertions: [
		{ id: "disabled-routes-are-absent", type: "client", status: 404 },
		{ id: "disabled-routes-never-forward", type: "upstream", count: 0 },
	],
});
