import type {
	ProviderSupply,
	SupplyExecutorFactory,
	SupplySessionExecutor,
} from "@agent-smith/pool";
import type { Provider } from "@agent-smith/providers";
import { proxyWithAccount } from "./handlers/proxy-operations";
import type { ProxyContext } from "./handlers/proxy-types";

/** Bind the HTTP executor while the pool owns account choice and reported facts. */
export function createSupplyExecutorFactory(
	proxy: ProxyContext,
): SupplyExecutorFactory {
	return (route, request) => (account, failoverAttempts, report) =>
		proxyWithAccount(
			request.req,
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
	sessionExecutor?: SupplySessionExecutor,
): ProviderSupply {
	const supply = proxy.routedProviders.get(provider.name);
	if (!supply) throw new Error(`Provider supply unavailable: ${provider.name}`);
	if (sessionExecutor) supply.setSessionExecutor(sessionExecutor);
	return supply;
}
