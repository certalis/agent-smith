import { defineScenario } from "./harness/scenario";
import {
	drainControl,
	standaloneRequest,
	standaloneWire,
} from "./harness/wire-fixture";

export default defineScenario({
	...standaloneWire,
	name: "deploy drain lease renewal expiry and restart cannot strand serving paused",
	upstream: [{ status: 200, json: { served: true } }],
	steps: [
		{ ...drainControl, method: "POST" },
		{ type: "advance", by: "60s" },
		{ ...drainControl, method: "POST" },
		{ type: "advance", by: "60s" },
		{ ...standaloneRequest, id: "renewed-lease" },
		{
			type: "assert",
			assertions: [
				{ id: "renewal-still-blocks-provider", type: "upstream", count: 0 },
			],
		},
		{ type: "advance", by: "60s" },
		{ ...drainControl, method: "GET", id: "expired-status" },
		{ ...standaloneRequest, id: "expired-lease" },
		{ ...drainControl, method: "POST" },
		{ type: "restart" },
		{ ...drainControl, method: "GET", id: "restart-status" },
		{ ...standaloneRequest, id: "after-restart" },
	],
	assertions: [
		{
			id: "renewal-extends-pause-past-the-first-deadline",
			type: "client",
			request: "renewed-lease",
			status: 503,
		},
		...(["expired-status", "restart-status"] as const).flatMap((request) => [
			{
				id: `${request}-is-serving`,
				type: "client" as const,
				request,
				status: 200,
				jsonPath: { path: "draining", value: false },
			},
			{
				id: `${request}-has-no-lease`,
				type: "client" as const,
				request,
				jsonPath: { path: "expiresAt", value: null },
			},
		]),
		...(["expired-lease", "after-restart"] as const).map((request) => ({
			id: `${request}-admits-new-work`,
			type: "client" as const,
			request,
			status: 200,
		})),
		{ id: "only-unpaused-work-reaches-provider", type: "upstream", count: 2 },
	],
});
