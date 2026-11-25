import { requestEvents, ServiceUnavailableError } from "@agent-smith/core";
import { Logger } from "@agent-smith/logger";
import type { TeamRoutingRequest } from "@agent-smith/pool";
import type { ResolvedProviderPool } from "@agent-smith/providers";
import {
	getConversationProviderKey,
	hasOrderedProviderFallback,
} from "@agent-smith/routing";
import type { RequestMeta } from "@agent-smith/types";
import {
	buildRouteRequest,
	createResolvedProxyContext,
	ERROR_MESSAGES,
	type ProxyContext,
	type ResolvedProxyContext,
} from "./handlers";
import { getProviderSupply } from "./supply-executor";

const log = new Logger("Proxy");

export async function routePoolRequest(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	meta: RequestMeta,
	body: ArrayBuffer | null,
	pool: ResolvedProviderPool,
	manualAccountName?: string,
	callerId?: string,
): Promise<Response> {
	const first = pool.providers[0];
	if (!first)
		return new Response(
			`No provider in provider_pools.${pool.wire} serves the requested model`,
			{ status: 400 },
		);
	const teamRequest: TeamRoutingRequest = {
		body,
		callerId,
		contentType: req.headers.get("content-type"),
		manualAccountName,
		model: meta.model,
		pinBucket: meta.model,
		pinScope: `pool:${pool.wire}`,
		provider: `pool:${pool.wire}`,
		sessionId: first.provider.getClientSessionId?.(req.headers) ?? null,
	};
	const firstContext = createResolvedProxyContext(
		ctx,
		first.provider,
		pool.upstreamPath,
	);
	let emitted = false;
	const route = buildRouteRequest(
		req,
		url,
		firstContext,
		meta,
		body,
		teamRequest,
		"pool-route",
		() => {
			if (emitted) return;
			requestEvents.emit("event", {
				type: "ingress",
				id: meta.id,
				timestamp: meta.timestamp,
				method: meta.method,
				path: meta.path,
			});
			emitted = true;
		},
	);
	const quotaHold = ctx.quotaHold;
	return ctx.router.route({
		route,
		providers: pool.providers.map(({ provider }) =>
			getProviderSupply(ctx, provider),
		),
		headers: req.headers,
		orderedFallback: hasOrderedProviderFallback(
			ctx.runtime.teamRouting,
			callerId,
		),
		teamRoutingEnabled: ctx.runtime.teamRouting.enabled,
		conversationKey: ctx.conversationPinsEnabled
			? getConversationProviderKey(teamRequest)
			: undefined,
		holdSeconds: ctx.runtime.teamRouting.holdSeconds,
		waitUntil: quotaHold
			? (at, signal) => quotaHold.waitUntil(at, signal)
			: undefined,
		onRouteFull: (resetAt) =>
			ctx.onRouteFull?.(`provider_pools.${pool.wire}`, resetAt),
		noEligible: () => {
			log.warn(ERROR_MESSAGES.NO_ELIGIBLE_ACCOUNT);
			throw new ServiceUnavailableError(
				ERROR_MESSAGES.NO_ELIGIBLE_ACCOUNT,
				`pool:${pool.wire}`,
			);
		},
	});
}

export async function routeDirectRequest(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	resolved: ResolvedProxyContext,
	meta: RequestMeta,
	body: ArrayBuffer | null,
	manualAccountName?: string,
	callerId?: string,
	originalPath = url.pathname,
): Promise<Response> {
	const teamRequest: TeamRoutingRequest = {
		body,
		contentType: req.headers.get("content-type"),
		manualAccountName,
		model: meta.model,
		provider: resolved.providerName,
		sessionId: resolved.provider.getClientSessionId?.(req.headers) ?? null,
		callerId,
	};
	const route = buildRouteRequest(
		req,
		url,
		resolved,
		meta,
		body,
		teamRequest,
		"direct",
		() => {
			requestEvents.emit("event", {
				type: "ingress",
				id: meta.id,
				timestamp: meta.timestamp,
				method: meta.method,
				path: meta.path,
			});
			log.info(`Request: ${req.method} ${originalPath}`);
		},
	);
	const holdSeconds =
		resolved.runtime.teamRouting.enabled && ctx.quotaHold
			? resolved.runtime.teamRouting.holdSeconds
			: 0;
	const quotaHold = ctx.quotaHold;
	return ctx.router.route({
		route,
		providers: [getProviderSupply(ctx, resolved.provider)],
		headers: req.headers,
		orderedFallback: false,
		teamRoutingEnabled: resolved.runtime.teamRouting.enabled,
		holdSeconds,
		waitUntil: quotaHold
			? (at, signal) => quotaHold.waitUntil(at, signal)
			: undefined,
		onDirectFull: () => ctx.onProviderFull?.(route, holdSeconds),
		noEligible: () => {
			log.warn(ERROR_MESSAGES.NO_ELIGIBLE_ACCOUNT);
			throw new ServiceUnavailableError(
				ERROR_MESSAGES.NO_ELIGIBLE_ACCOUNT,
				resolved.providerName,
			);
		},
		allFailed: (attempts) => {
			throw new ServiceUnavailableError(
				`${ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (${attempts} attempted)`,
				resolved.providerName,
			);
		},
	});
}
