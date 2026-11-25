import { defineScenario, type Scenario } from "./harness/scenario";
import {
	standaloneRequest,
	standaloneWire,
	wireProxyKey,
} from "./harness/wire-fixture";

type Caller = "ordinary" | "ordered" | "chooser" | "pick";
const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;

function reachScenario(
	team: boolean,
	mixed: boolean,
	pool: boolean,
	caller: Caller,
): Scenario {
	const route = pool
		? "/v1/pool/anthropic-messages/v1/messages"
		: "/v1/reach-provider/v1/messages";
	const keyReachable = !team || (pool && caller !== "ordinary");
	const seatReachable = mixed && !keyReachable;
	const hasAccount = keyReachable || seatReachable;
	const headers: Record<string, string> = { ...standaloneRequest.headers };
	// Direct routes are private to the proxy key; device keys can call pool routes only.
	if (!pool) headers["x-api-key"] = wireProxyKey;
	if (caller === "chooser" || caller === "pick")
		headers["x-agent-smith-interactive-provider-choice"] = "v1";
	if (caller === "pick")
		headers["x-agent-smith-provider-choice"] = "reach-provider";
	return defineScenario({
		...standaloneWire,
		...(pool ? {} : { standalone: false, edge: {} }),
		name: `API-key reach: team ${team ? "on" : "off"}, ${mixed ? "mixed" : "keys only"}, ${pool ? "pool" : "direct"}, ${caller}`,
		config: {
			providers: {
				"reach-provider": { enabled: true, strategy: "anthropic-api" },
			},
			provider_pools: { "anthropic-messages": ["reach-provider"] },
			team_routing: {
				enabled: team,
				allowlisted_account_uuids: ["seat-uuid"],
				caller_provider_fallback:
					caller === "ordered" ? { "synthetic-device": "ordered" } : {},
			},
		},
		fleet: [
			{ name: "key", provider: "reach-provider", authMethod: "api_key" },
			...(mixed
				? [
						{
							name: "seat",
							provider: "reach-provider",
							accountUuid: "seat-uuid",
						},
					]
				: []),
		],
		upstream: [{ status: 200, json: { ok: true } }],
		steps: [
			{ ...standaloneRequest, id: "request", path: route, body, headers },
		],
		assertions: [
			{
				id: "client-status",
				type: "client",
				request: "request",
				status: hasAccount ? 200 : 503,
			},
			keyReachable
				? { id: "key-is-reached", type: "upstream", accounts: ["key"] }
				: seatReachable
					? {
							id: "only-oauth-seat-is-reached",
							type: "upstream",
							count: 1,
							headerAbsent: "x-api-key",
						}
					: { id: "no-account-reached", type: "upstream", count: 0 },
		],
	});
}

export const reachScenarios = [false, true].flatMap((team) =>
	[false, true].flatMap((mixed) =>
		[false, true].flatMap((pool) =>
			(["ordinary", "ordered", "chooser", "pick"] as const).map((caller) =>
				reachScenario(team, mixed, pool, caller),
			),
		),
	),
);
export default reachScenarios[0] as Scenario;
