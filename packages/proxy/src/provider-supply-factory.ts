import { type PoolContext, ProviderSupply } from "@agent-smith/pool";
import type { ProxyContext } from "./handlers/proxy-types";
import { createSupplyExecutorFactory } from "./supply-executor";
import { createWebSocketSupplyAttempt } from "./websocket-proxy";

/** Build the stable per-provider supplies that share this pool's state. */
export function createProviderSupplies(
	pool: PoolContext,
	proxy: ProxyContext,
): Map<string, ProviderSupply> {
	const registry = proxy.providerRegistry;
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
