import type { RouteRequest } from "@agent-smith/capacity";
import { getOpeningDigest, type TeamRoutingRequest } from "@agent-smith/pool";
import {
	interactiveProviderChoiceRequested,
	stripProviderChoiceHeaders,
} from "@agent-smith/routing";
import type { RequestMeta } from "@agent-smith/types";
import { hasOrderedProviderFallback } from "../provider-routing";
import type { ResolvedProxyContext } from "./proxy-types";

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
	const openingDigest =
		teamRequest.lookupOpeningDigest !== undefined
			? teamRequest.lookupOpeningDigest
			: getOpeningDigest(
					teamRequest,
					scope === "pool-route"
						? (ctx.providerRegistry.resolvePool(url.pathname, teamRequest.model)
								?.providers[0]?.provider ?? ctx.provider)
						: ctx.provider,
				);
	const interactive = interactiveProviderChoiceRequested(req.headers);
	return {
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
}
