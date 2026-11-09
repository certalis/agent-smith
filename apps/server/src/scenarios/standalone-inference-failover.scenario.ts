import { defineScenario } from "./harness/scenario";
import { standaloneRequest, standaloneWire } from "./harness/wire-fixture";

export default defineScenario({
	...standaloneWire,
	name: "standalone forwards authenticated inference and makes one synthetic provider failover",
	upstream: [
		{
			account: "primary",
			path: "/v1/messages",
			status: 529,
			json: { type: "error" },
		},
		{
			account: "sibling",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
		},
	],
	steps: [{ type: "advance", by: "1s" }, standaloneRequest],
	assertions: [
		{
			id: "sibling-response-reaches-public-client",
			type: "client",
			status: 200,
			jsonPath: { path: "ok", value: true },
		},
		{
			id: "one-bounded-hop-keeps-wire-bytes",
			type: "upstream",
			count: 2,
			accounts: ["primary", "sibling"],
			bodyIdentical: standaloneRequest.body,
		},
		{
			id: "device-key-is-not-forwarded-to-provider",
			type: "upstream",
			headerAbsent: "x-api-key",
		},
	],
});
