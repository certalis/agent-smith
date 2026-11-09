import { requestEvents, ServiceUnavailableError } from "@agent-smith/core";
import { Logger } from "@agent-smith/logger";
import type { ResolvedProviderPool } from "@agent-smith/providers";
import type { Account, RequestMeta } from "@agent-smith/types";
import {
	createResolvedProxyContext,
	ERROR_MESSAGES,
	getSoonestQuotaReset,
	isEveryAccountQuotaBlocked,
	type ProxyContext,
} from "./handlers";
import {
	attemptAccount,
	discardAttempt,
	quotaExhaustionResponse,
	resolvePerMinuteRateLimit,
	resolveQuotaRateLimit,
	resolveRequestScopedRateLimit,
	resolveTransportFailure,
	resolveUpstreamFailure,
} from "./handlers/proxy-attempts";
import {
	getRequestRetryAt,
	type ProxyRequest,
	prepareProxyRequest,
} from "./handlers/proxy-request";
import type { TeamRoutingRequest } from "./team-router";

const log = new Logger("Proxy");

type PoolCandidateResult =
	| { kind: "next-provider" }
	| { account?: Account; kind: "response"; response: Response };

function poolTeamRequest(
	req: Request,
	body: ArrayBuffer | null,
	pool: ResolvedProviderPool,
	requestedModel: string | undefined,
	manualAccountName: string | undefined,
): TeamRoutingRequest {
	return {
		body,
		contentType: req.headers.get("content-type"),
		manualAccountName,
		model: requestedModel,
		pinBucket: requestedModel,
		pinScope: `pool:${pool.wire}`,
		provider: `pool:${pool.wire}`,
		sessionId:
			pool.providers[0]?.provider.getClientSessionId?.(req.headers) ?? null,
	};
}

function preferPinnedAccount(
	accounts: Account[],
	pinnedId: string | undefined,
): Account[] {
	if (!pinnedId) return accounts;
	const pinned = accounts.find((account) => account.id === pinnedId);
	return pinned
		? [pinned, ...accounts.filter((account) => account.id !== pinned.id)]
		: accounts;
}

function preferPinnedProvider(
	pool: ResolvedProviderPool,
	pinnedAccount: Account | null,
): ResolvedProviderPool["providers"] {
	if (!pinnedAccount) return pool.providers;
	const pinned = pool.providers.find(
		(candidate) => candidate.provider.name === pinnedAccount.provider,
	);
	return pinned
		? [pinned, ...pool.providers.filter((candidate) => candidate !== pinned)]
		: pool.providers;
}

async function proxyPoolCandidate(
	request: ProxyRequest,
	accounts: Account[],
	allowNextProvider: boolean,
): Promise<PoolCandidateResult> {
	for (let index = 0; index < accounts.length; index += 1) {
		const account = accounts[index] as Account;
		const attempt = await attemptAccount(request, account, index);
		if (attempt.kind === "response") {
			return { account, kind: "response", response: attempt.response };
		}
		if (attempt.kind === "authentication-failure") {
			return {
				kind: "response",
				response: new Response("Bad Gateway", { status: 502 }),
			};
		}
		if (attempt.kind === "per-minute-rate-limit") {
			return {
				kind: "response",
				response: await resolvePerMinuteRateLimit(
					request,
					account,
					index,
					attempt,
				),
			};
		}
		if (attempt.kind === "request-scoped-rate-limit") {
			return {
				kind: "response",
				response: await resolveRequestScopedRateLimit(
					request,
					accounts,
					index,
					attempt,
				),
			};
		}
		if (attempt.kind === "quota-rate-limit") {
			if (!accounts[index + 1]) {
				if (!allowNextProvider) {
					return { kind: "response", response: await attempt.forward() };
				}
				await attempt.discard?.();
				return { kind: "next-provider" };
			}
			return {
				kind: "response",
				response: await resolveQuotaRateLimit(
					request,
					accounts,
					index,
					attempt,
				),
			};
		}
		if (attempt.kind === "upstream-failure") {
			if (!accounts[index + 1]) {
				if (!allowNextProvider) {
					return { kind: "response", response: await attempt.forward() };
				}
				await discardAttempt(attempt);
				return { kind: "next-provider" };
			}
			return {
				kind: "response",
				response: await resolveUpstreamFailure(
					request,
					accounts,
					index,
					attempt,
				),
			};
		}
		if (attempt.kind === "transport-failure") {
			if (!accounts[index + 1]) {
				return allowNextProvider
					? { kind: "next-provider" }
					: {
							kind: "response",
							response: new Response("Bad Gateway", { status: 502 }),
						};
			}
			return {
				kind: "response",
				response: await resolveTransportFailure(request, accounts, index),
			};
		}
	}
	return allowNextProvider
		? { kind: "next-provider" }
		: {
				kind: "response",
				response: new Response("Bad Gateway", { status: 502 }),
			};
}

export async function proxyProviderPool(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	meta: RequestMeta,
	body: ArrayBuffer | null,
	pool: ResolvedProviderPool,
	manualAccountName?: string,
): Promise<Response> {
	const firstCandidate = pool.providers[0];
	if (!firstCandidate) {
		return new Response(
			`No provider in provider_pools.${pool.wire} serves the requested model`,
			{ status: 400 },
		);
	}
	const teamRequest = poolTeamRequest(
		req,
		body,
		pool,
		meta.model,
		manualAccountName,
	);
	const firstContext = createResolvedProxyContext(
		ctx,
		firstCandidate.provider,
		pool.upstreamPath,
	);
	const pinnedId = firstContext.teamRouter?.getPinnedAccountId(
		teamRequest,
		firstContext.runtime.teamRouting,
		firstContext.provider,
		firstContext.dbOps,
	);
	const pinnedAccount = pinnedId ? ctx.dbOps.getAccount(pinnedId) : null;
	let soonestRetry: number | null = null;
	let soonestFleetReset: number | null = null;
	let everyCandidateFull = true;
	let emittedIngress = false;
	const earliest = (current: number | null, next: number | null) =>
		next !== null && (current === null || next < current) ? next : current;
	const recordUnserved = (request: ProxyRequest) => {
		everyCandidateFull &&= isEveryAccountQuotaBlocked(
			request.meta,
			request.ctx,
		);
		soonestRetry = earliest(soonestRetry, getRequestRetryAt(request));
		soonestFleetReset = earliest(
			soonestFleetReset,
			getSoonestQuotaReset(request.meta, request.ctx),
		);
	};

	const candidates = preferPinnedProvider(pool, pinnedAccount).slice(0, 2);
	for (const [candidateIndex, candidate] of candidates.entries()) {
		const candidateContext = createResolvedProxyContext(
			ctx,
			candidate.provider,
			pool.upstreamPath,
		);
		const candidateMeta = { ...meta, model: candidate.model };
		const prepared = prepareProxyRequest(
			req,
			url,
			candidateContext,
			candidateMeta,
			body,
			manualAccountName,
			teamRequest,
			candidate.model,
			{ allowRevalidationProbe: false, applyTeamRouting: false },
		);
		let accounts = prepared.accounts;
		if (candidateContext.teamRouter) {
			accounts = candidateContext.teamRouter.eligibleAccounts(
				accounts,
				teamRequest,
				candidateContext.runtime.teamRouting,
			);
		}
		accounts = preferPinnedAccount(accounts, pinnedId);
		if (accounts.length === 0) {
			recordUnserved(prepared.request);
			continue;
		}

		if (!emittedIngress) {
			requestEvents.emit("event", {
				type: "ingress",
				id: meta.id,
				timestamp: meta.timestamp,
				method: meta.method,
				path: meta.path,
			});
			emittedIngress = true;
		}
		log.info(
			`Selected ${accounts.length} accounts: ${accounts.map((account) => account.name).join(", ")}`,
		);
		const result = await proxyPoolCandidate(
			prepared.request,
			accounts,
			candidateIndex === 0,
		);
		if (result.kind === "response") {
			if (result.account) {
				candidateContext.teamRouter?.rebind(
					teamRequest,
					result.account.id,
					candidateContext.runtime.teamRouting,
					candidateContext.provider,
					candidateContext.dbOps,
				);
			}
			return result.response;
		}

		recordUnserved(prepared.request);
	}

	if (everyCandidateFull && soonestFleetReset !== null) {
		ctx.seatAlerts?.allAccountsFull(
			`provider_pools.${pool.wire}`,
			soonestFleetReset,
			{ blocked: true, holdSeconds: 0 },
		);
	}
	if (soonestRetry !== null) return quotaExhaustionResponse(soonestRetry);
	log.warn(ERROR_MESSAGES.NO_ELIGIBLE_ACCOUNT);
	throw new ServiceUnavailableError(
		ERROR_MESSAGES.NO_ELIGIBLE_ACCOUNT,
		`pool:${pool.wire}`,
	);
}
