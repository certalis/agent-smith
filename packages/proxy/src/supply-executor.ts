import type { RoutedProvider } from "@agent-smith/capacity";
import type { SupplyExecutorFactory } from "@agent-smith/pool";
import type { Provider } from "@agent-smith/providers";
import { proxyWithAccount } from "./handlers/proxy-operations";
import { getOriginalRequest } from "./handlers/proxy-request";
import type { ProxyContext } from "./handlers/proxy-types";

/** Bind the HTTP executor while the pool owns account choice and reported facts. */
export function createSupplyExecutorFactory(
	proxy: ProxyContext,
): SupplyExecutorFactory {
	return (route, request) => (account, failoverAttempts, report) =>
		proxyWithAccount(
			getOriginalRequest(route) ?? request.req,
			request.url,
			account,
			request.meta,
			request.body,
			(body) => (body ? (new Response(body).body ?? undefined) : undefined),
			request.thread,
			failoverAttempts,
			request.mappedModel,
			{
				...proxy,
				runtime: request.ctx.runtime,
				provider: request.ctx.provider,
				providerName: request.ctx.providerName,
				upstreamPath: request.ctx.upstreamPath,
			},
			request.ctx,
			route.inlineRateLimitRetry,
			report,
		);
}

/** Constructed once per provider, including in lightweight test contexts. */
export function getProviderSupply(
	proxy: ProxyContext,
	provider: Provider,
): RoutedProvider {
	const supply = proxy.routedProviders.get(provider.name);
	if (!supply) throw new Error(`Provider supply unavailable: ${provider.name}`);
	return supply;
}
