import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "the Node edge returns 502 when its private socket is unavailable",
	edge: { privateTarget: "missing" },
	fleet: [],
	upstream: [],
	steps: [{ type: "request", transport: "edge", body: "" }],
	assertions: [
		{
			id: "missing-private-socket-is-bad-gateway",
			type: "client",
			status: 502,
		},
		{ id: "no-tcp-fallback", type: "upstream", count: 0, connections: 0 },
	],
});
