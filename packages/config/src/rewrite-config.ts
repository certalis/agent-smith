import { BUILTIN_PROVIDER_CONFIGS } from "./builtin-providers";

/** Rewrite a legacy JSON config without reading credentials, the database or the network. */
export function rewriteLegacyConfig(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("Configuration must be a JSON object");
	const output = structuredClone(value);
	const hasTeam = Object.hasOwn(output, "team_routing");
	const hasRoutes = Object.hasOwn(output, "provider_pools");
	const hasBlockPolicy = Object.hasOwn(output, "block_when_all_full");
	if (!hasTeam && !hasRoutes && !hasBlockPolicy) return output;
	if (Object.hasOwn(output, "routing"))
		throw new Error(
			"Cannot rewrite a config containing both legacy keys and routing",
		);
	const team = hasTeam ? output.team_routing : {};
	const routes = hasRoutes ? output.provider_pools : {};
	if (!isRecord(team) || !isRecord(routes))
		throw new Error("Legacy team_routing and provider_pools must be objects");
	if (output.providers !== undefined && !isRecord(output.providers))
		throw new Error("Legacy providers must be an object");
	const providers: Record<string, unknown> = structuredClone(
		(output.providers ?? {}) as Record<string, unknown>,
	);
	if (
		Object.values(providers).some(
			(provider) => !isRecord(provider) || Object.hasOwn(provider, "pool"),
		)
	)
		throw new Error(
			"Cannot rewrite invalid providers or existing provider pools",
		);
	const knownTeamFields = new Set([
		"enabled",
		"allowlisted_account_uuids",
		"distribution_enabled",
		"prefer_expiring_quota",
		"max_usage",
		"weekly_max_usage",
		"weekly_max_usage_by_email",
		"caller_weekly_max_usage",
		"caller_provider_fallback",
		"admission_cap",
		"admission_queue_limit",
		"admission_wait_ms",
		"hold_seconds",
		"quota_probe_seconds",
		"window_warmup",
	]);
	if (Object.keys(team).some((field) => !knownTeamFields.has(field)))
		throw new Error("Cannot safely rewrite unknown team_routing fields");
	if (team.enabled !== undefined && typeof team.enabled !== "boolean")
		throw new Error("Invalid team_routing.enabled");
	if (hasBlockPolicy && typeof output.block_when_all_full !== "boolean")
		throw new Error("Invalid block_when_all_full");
	if (
		team.caller_provider_fallback !== undefined &&
		(!isRecord(team.caller_provider_fallback) ||
			Object.values(team.caller_provider_fallback).some(
				(policy) => policy !== "ordered",
			))
	)
		throw new Error("Invalid caller_provider_fallback");
	const enabled = team.enabled === true;
	const dormantFields = [
		"allowlisted_account_uuids",
		"distribution_enabled",
		"prefer_expiring_quota",
		"max_usage",
		"weekly_max_usage",
		"weekly_max_usage_by_email",
		"caller_weekly_max_usage",
		"admission_cap",
		"admission_queue_limit",
		"admission_wait_ms",
		"quota_probe_seconds",
		"window_warmup",
	];
	const keepPool =
		enabled ||
		hasBlockPolicy ||
		dormantFields.some((field) => Object.hasOwn(team, field));
	const callers: Record<string, { allow_fallbacks: boolean }> = {};
	if (enabled && isRecord(team.caller_provider_fallback)) {
		for (const [caller, policy] of Object.entries(
			team.caller_provider_fallback,
		))
			if (policy === "ordered") callers[caller] = { allow_fallbacks: true };
	}
	const routing = {
		routes: structuredClone(routes),
		api_key_accounts: enabled ? "chooser_or_fallback" : "everyone",
		callers,
		hold_seconds: typeof team.hold_seconds === "number" ? team.hold_seconds : 0,
	};
	if (keepPool) {
		const pool: Record<string, unknown> = {
			...(!enabled && { enabled: false }),
			members: structuredClone(team.allowlisted_account_uuids ?? []),
		};
		for (const field of [
			"distribution_enabled",
			"prefer_expiring_quota",
			"max_usage",
			"weekly_max_usage",
			"weekly_max_usage_by_email",
			"caller_weekly_max_usage",
			"quota_probe_seconds",
			"window_warmup",
		])
			if (Object.hasOwn(team, field))
				pool[field] = structuredClone(team[field]);
		const admission: Record<string, unknown> = {};
		for (const [oldKey, newKey] of [
			["admission_cap", "cap"],
			["admission_queue_limit", "queue_limit"],
			["admission_wait_ms", "wait_ms"],
		])
			if (Object.hasOwn(team, oldKey)) admission[newKey] = team[oldKey];
		if (Object.keys(admission).length) pool.admission = admission;
		if (hasBlockPolicy) pool.block_when_all_full = output.block_when_all_full;
		// Old sharing covered every provider, including ones enabled later; do not guess account types from names.
		for (const { name } of BUILTIN_PROVIDER_CONFIGS)
			if (!Object.hasOwn(providers, name)) providers[name] = {};
		for (const [name, entry] of Object.entries(providers)) {
			if (!isRecord(entry)) throw new Error(`Invalid provider: ${name}`);
			providers[name] = { ...entry, pool: structuredClone(pool) };
		}
	}
	delete output.team_routing;
	delete output.provider_pools;
	delete output.block_when_all_full;
	output.providers = providers;
	output.routing = routing;
	return output;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
