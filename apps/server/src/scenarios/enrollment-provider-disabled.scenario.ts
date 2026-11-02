import { enrollmentEnvironment } from "./harness/enrollment-fixture";
import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "private enrollment issues no invitation while claude-code is disabled",
	config: { providers: { "claude-code": { enabled: false } } },
	environment: enrollmentEnvironment,
	fleet: [],
	upstream: [],
	steps: [
		{
			type: "request",
			path: "/api/enrollment-invitations",
			headers: { "x-api-key": "scenario-admin-key" },
			body: "{}",
		},
	],
	assertions: [
		{ id: "invitation-refused", type: "client", status: 400 },
		{
			id: "refusal-names-the-config-key",
			type: "client",
			bodyIncludes: "providers.claude-code.enabled",
		},
		{ id: "refusal-never-forwards", type: "upstream", count: 0 },
	],
});
