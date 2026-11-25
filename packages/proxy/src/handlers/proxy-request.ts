import type { RouteRequest } from "@agent-smith/capacity";
import { getOpeningDigest, type TeamRoutingRequest } from "@agent-smith/pool";
import {
	interactiveProviderChoiceRequested,
	stripProviderChoiceHeaders,
} from "@agent-smith/routing";
import type { RequestMeta } from "@agent-smith/types";
import type { ResolvedProxyContext } from "./proxy-types";

// Keep client-only headers on the proxy side, outside the pool's route view.
const originalRequests = new WeakMap<RouteRequest, Request>();

export function getOriginalRequest(route: RouteRequest): Request | undefined {
	return originalRequests.get(route);
}

/** Transitional route builder until Router owns request creation in the next PR. */
export function buildRouteRequest(
	req: Request,
	url: URL,
	ctx: ResolvedProxyContext,
	meta: RequestMeta,
	body: ArrayBuffer | null,
	teamRequest: TeamRoutingRequest,
	scope: "direct" | "pool-route",
	beforeAttempt?: () => void,
): RouteRequest {
	const routeHasPool =
		scope === "pool-route" &&
		ctx.runtime.providerPools &&
		ctx.providerRegistry
			.resolvePool(url.pathname, teamRequest.model)
			?.providers.some(
				(candidate) =>
					ctx.runtime.providerPools?.[candidate.provider.name]?.teamRouting
						.enabled,
			);
	const shouldParseOpening =
		(ctx.runtime.teamRouting.enabled || routeHasPool === true) &&
		!!teamRequest.sessionId &&
		(scope === "direct" || !teamRequest.manualAccountName);
	if (shouldParseOpening && teamRequest.lookupOpeningDigest === undefined) {
		const firstProvider =
			scope === "pool-route"
				? (ctx.providerRegistry.resolvePool(url.pathname, teamRequest.model)
						?.providers[0]?.provider ?? ctx.provider)
				: ctx.provider;
		teamRequest.lookupOpeningDigest = getOpeningDigest(
			teamRequest,
			firstProvider,
		);
	}
	const openingDigest = shouldParseOpening
		? (teamRequest.lookupOpeningDigest ?? null)
		: null;
	const interactive = interactiveProviderChoiceRequested(req.headers);
	const route: RouteRequest = {
		scope:
			scope === "pool-route"
				? { kind: "pool-route", wire: ctx.provider.wire }
				: { kind: "direct", provider: ctx.providerName },
		edge: {
			method: req.method,
			url,
			headers: stripProviderChoiceHeaders(req.headers),
			body,
			meta: { ...meta, model: teamRequest.model },
		},
		model: teamRequest.model,
		callerId: teamRequest.callerId,
		sessionId: teamRequest.sessionId,
		openingDigest,
		seatHint: teamRequest.manualAccountName,
		apiKeyAccounts: false,
		inlineRateLimitRetry: interactive,
		signal: req.signal,
		beforeAttempt,
	};
	originalRequests.set(route, req);
	return route;
}
