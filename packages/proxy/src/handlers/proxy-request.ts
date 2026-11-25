import type { RouteRequest } from "@agent-smith/capacity";
import { getOpeningDigest, type TeamRoutingRequest } from "@agent-smith/pool";
import {
	interactiveProviderChoiceRequested,
	stripProviderChoiceHeaders,
} from "@agent-smith/routing";
import type { RequestMeta } from "@agent-smith/types";
import { hasOrderedProviderFallback } from "../provider-routing";
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
	const shouldParseOpening =
		ctx.runtime.teamRouting.enabled &&
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
	if (ctx.runtime.teamRouting.enabled) teamRequest.seatPinLookup ??= {};
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
		seatPinLookup: teamRequest.seatPinLookup,
		seatHint: teamRequest.manualAccountName,
		apiKeyAccounts:
			scope === "pool-route" &&
			(interactive ||
				hasOrderedProviderFallback(
					ctx.runtime.teamRouting,
					teamRequest.callerId,
				)),
		inlineRateLimitRetry: interactive,
		signal: req.signal,
		beforeAttempt,
	};
	originalRequests.set(route, req);
	return route;
}
