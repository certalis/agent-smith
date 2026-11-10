import { defineScenario, type RequestStep } from "./harness/scenario";
import {
	poolWire,
	wireAdminKey,
	wireDeviceKey,
	wireProxyKey,
} from "./harness/wire-fixture";

const control = {
	type: "request",
	transport: "unix",
	path: "/api/drain",
	body: "",
} as const;
const methods = ["GET", "POST", "DELETE"] as const;

export default defineScenario({
	...poolWire,
	name: "deploy drain control requires a private admin key even for status",
	upstream: [],
	steps: [
		...methods.flatMap((method): RequestStep[] => [
			{
				...control,
				id: "proxy-key",
				method,
				headers: { "x-api-key": wireProxyKey },
			},
			{
				...control,
				id: "device-key",
				method,
				headers: { "x-api-key": wireDeviceKey },
			},
		]),
		...methods.map((method) => ({
			...control,
			id: "cross-origin",
			method,
			headers: {
				"x-api-key": wireAdminKey,
				origin: "https://attacker.example",
			},
		})),
		...methods.map(
			(method): RequestStep => ({
				...control,
				id: "public-control",
				method,
				transport: "edge",
				headers: { "x-api-key": wireAdminKey },
			}),
		),
		{
			...control,
			id: "admin-status",
			method: "GET",
			headers: { "x-api-key": wireAdminKey },
		},
	],
	assertions: [
		{
			id: "proxy-key-cannot-control-or-observe-drain",
			type: "client",
			request: "proxy-key",
			statuses: [401, 401, 401],
		},
		{
			id: "device-key-cannot-control-or-observe-drain",
			type: "client",
			request: "device-key",
			statuses: [403, 403, 403],
		},
		{
			id: "cross-origin-admin-cannot-pause-service",
			type: "client",
			request: "cross-origin",
			statuses: [403, 403, 403],
		},
		{
			id: "public-edge-has-no-drain-control",
			type: "client",
			request: "public-control",
			statuses: [404, 404, 404],
		},
		{
			id: "private-admin-can-read-undrained-status",
			type: "client",
			request: "admin-status",
			status: 200,
			jsonPath: { path: "draining", value: false },
		},
		{ id: "control-never-reaches-provider", type: "upstream", count: 0 },
	],
});
