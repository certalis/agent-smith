import {
	alertWhenFleetFull,
	type PoolContext,
	ProviderSupply,
} from "@agent-smith/pool";
import type { ProxyContext } from "./handlers/proxy-types";
import { createSupplyExecutorFactory } from "./supply-executor";
import { createWebSocketSupplyAttempt } from "./websocket-proxy";

/** Build the stable per-provider supplies that share this pool's state. */
export function createProviderSupplies(
	pool: PoolContext,
	proxy: ProxyContext,
): Map<string, ProviderSupply> {
	const registry = proxy.providerRegistry;
	proxy.conversationPinsEnabled = pool.teamRouter !== undefined;
	proxy.onRouteFull = (scope, resetAt) =>
		pool.seatAlerts?.allAccountsFull(scope, resetAt, {
			blocked: true,
			holdSeconds: 0,
		});
	proxy.onProviderFull = (route, holdSeconds) => {
		const resolved = registry.resolveProvider(route.edge.url.pathname);
		if (!resolved) return;
		alertWhenFleetFull(
			route.edge.meta,
			{
				...pool,
				provider: resolved.provider,
				providerName: resolved.provider.name,
				upstreamPath: resolved.upstreamPath,
			},
			holdSeconds,
		);
	};
	const createExecutor = createSupplyExecutorFactory(proxy);
	const createSessionAttempt = createWebSocketSupplyAttempt(proxy);
	return new Map(
		registry.listProviders().flatMap((name) => {
			const provider = registry.getProvider(name);
			if (!provider) return [];
			return [
				[
					name,
					new ProviderSupply(provider, pool, {
						mapModel: (model) =>
							registry.mapModel(name, model) ??
							(model === undefined ? undefined : null),
						createExecutor,
						createSessionAttempt,
					}),
				] as const,
			];
		}),
	);
}
