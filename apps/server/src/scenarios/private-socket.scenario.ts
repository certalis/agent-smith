import {
	enrollmentEnvironment,
	issue,
	start,
} from "./harness/enrollment-fixture";
import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "private socket preserves authentication and shares enrollment state with TCP",
	privateSocket: true,
	environment: enrollmentEnvironment,
	fleet: [],
	upstream: [],
	steps: [
		{
			type: "request",
			id: "unauthenticated",
			transport: "unix",
			method: "GET",
			path: "/api/accounts",
			body: "",
		},
		{ ...issue("private"), transport: "unix" },
		start("private"),
	],
	assertions: [
		{
			id: "private-listener-requires-a-key",
			type: "client",
			request: "unauthenticated",
			status: 401,
		},
		{
			id: "private-listener-issues-invitation",
			type: "client",
			request: "private",
			status: 201,
		},
		{
			id: "tcp-listener-recognizes-private-invitation",
			type: "client",
			request: "private-start",
			status: 200,
		},
	],
});
