import { defineScenario } from "./harness/scenario";
import {
	standaloneHeaders,
	standaloneRequest,
	standaloneWire,
	wireAdminKey,
	wireDeviceKey,
} from "./harness/wire-fixture";

export default defineScenario({
	...standaloneWire,
	name: "standalone exposes public readiness and authenticated pool health without management access",
	upstream: [],
	steps: [
		{
			type: "request",
			id: "ready",
			method: "GET",
			path: "/readyz",
			body: "",
			headers: standaloneHeaders,
		},
		{
			type: "request",
			id: "private-health",
			method: "GET",
			path: "/pool-health",
			body: "",
			headers: standaloneHeaders,
		},
		{
			type: "request",
			id: "authorized-health",
			method: "GET",
			path: "/pool-health",
			body: "",
			headers: { ...standaloneHeaders, "x-api-key": wireDeviceKey },
		},
		{
			type: "request",
			id: "admin-refused",
			method: "GET",
			path: "/api/accounts",
			body: "",
			headers: { ...standaloneHeaders, "x-api-key": wireAdminKey },
		},
		{
			...standaloneRequest,
			id: "keyless-inference",
			headers: standaloneHeaders,
		},
		{
			...standaloneRequest,
			id: "unknown-device",
			headers: {
				...standaloneHeaders,
				"x-api-key": "synthetic-unknown-device-key-0001",
			},
		},
		{
			type: "request",
			id: "wrong-host",
			method: "GET",
			path: "/readyz",
			body: "",
			headers: { host: "wrong.example", connection: "close" },
		},
	],
	assertions: [
		{
			id: "public-boundary-statuses",
			type: "client",
			statuses: [200, 401, 200, 404, 401, 401, 404],
		},
		{
			id: "public-readiness-is-bounded",
			type: "client",
			request: "ready",
			body: "ready\n",
		},
		{
			id: "boundary-never-spends-provider-credentials",
			type: "upstream",
			count: 0,
			connections: 0,
		},
	],
});
