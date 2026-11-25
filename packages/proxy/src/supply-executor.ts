import type { SupplyExecutorFactory } from "@agent-smith/pool";
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
			{ ...proxy, ...request.ctx },
			route.inlineRateLimitRetry,
			report,
		);
}
