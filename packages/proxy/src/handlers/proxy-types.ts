import type { RoutedProvider, RouteRequest } from "@agent-smith/capacity";
import type { PoolContext } from "@agent-smith/pool";
import type { Provider } from "@agent-smith/providers";
import type { QuotaHold, Router } from "@agent-smith/routing";
import type { AccountProvider } from "@agent-smith/types";
import type { UsageWorkerTransport } from "../usage-worker";

export interface ProxyContext
	extends Pick<
		PoolContext,
		"strategy" | "dbOps" | "runtime" | "providerRegistry" | "asyncWriter"
	> {
	routedProviders: Map<string, RoutedProvider>;
	router: Router;
	conversationPinsEnabled?: boolean;
	onRouteFull?: (scope: string, resetAt: number) => void;
	onProviderFull?: (route: RouteRequest, holdSeconds: number) => void;
	quotaHold?: QuotaHold;
	usageWorker: UsageWorkerTransport;
}

export interface ResolvedProxyContext extends ProxyContext {
	provider: Provider;
	providerName: AccountProvider;
	upstreamPath: string;
}

export function createResolvedProxyContext(
	ctx: ProxyContext,
	provider: Provider,
	upstreamPath: string,
): ResolvedProxyContext {
	return {
		...ctx,
		provider,
		providerName: provider.name,
		upstreamPath,
	};
}

export function resolveProxyContext(
	url: URL,
	ctx: ProxyContext,
): ResolvedProxyContext | null {
	const resolvedProvider = ctx.providerRegistry.resolveProvider(url.pathname);
	if (!resolvedProvider) {
		return null;
	}

	return createResolvedProxyContext(
		ctx,
		resolvedProvider.provider,
		resolvedProvider.upstreamPath,
	);
}

/** Error messages used throughout the proxy module */
export const ERROR_MESSAGES = {
	NO_ELIGIBLE_ACCOUNT: "No eligible account available for this provider",
	PROVIDER_CANNOT_HANDLE: "Provider cannot handle path",
	REFRESH_NOT_FOUND: "Refresh promise not found for account",
	ALL_ACCOUNTS_FAILED: "All accounts failed to proxy the request",
	TOKEN_REFRESH_FAILED: "Failed to refresh access token",
	PROXY_REQUEST_FAILED: "Failed to proxy request with account",
} as const;

/** Timing constants */
export const TIMING = {
	WORKER_SHUTDOWN_DELAY: 5000, // ms
} as const;

/** HTTP headers used in proxy operations */
export const HEADERS = {
	CONTENT_TYPE: "Content-Type",
	AUTHORIZATION: "Authorization",
} as const;
