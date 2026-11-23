import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import { requestEvents, ServiceUnavailableError } from "@agent-smith/core";
import { Logger } from "@agent-smith/logger";
import type { ResolvedProviderPool } from "@agent-smith/providers";
import {
	ConversationProviderRouting,
	capacityChoices,
	createProviderCapacityProblem,
	createProviderChoiceProblem,
	interactiveProviderChoiceRequested,
	manualProviderChoiceRequested,
	type ProviderChoice,
	providerPromotionDeclined,
	providerWaitRequested,
	readProviderChoice,
	withProviderPromotionDetails,
	withServedProviderHeaders,
} from "@agent-smith/routing";
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
import { PoolConversationProviderRoutingStore } from "./pool/conversation-provider-routing-store";
import type { TeamRoutingRequest } from "./team-router";

const log = new Logger("Proxy");

type PoolCandidateResult =
	| { block: ProviderCapacityBlock; kind: "capacity-block" }
	| { kind: "next-provider" }
	| { account?: Account; kind: "response"; response: Response };

function poolTeamRequest(
	req: Request,
	body: ArrayBuffer | null,
	pool: ResolvedProviderPool,
	requestedModel: string | undefined,
	manualAccountName: string | undefined,
	callerId: string | undefined,
): TeamRoutingRequest {
	return {
		body,
		callerId,
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

function preferProvider(
	providers: ResolvedProviderPool["providers"],
	providerName: string | undefined,
): ResolvedProviderPool["providers"] {
	if (!providerName) return providers;
	const preferred = providers.find(
		(candidate) => candidate.provider.name === providerName,
	);
	return preferred
		? [preferred, ...providers.filter((candidate) => candidate !== preferred)]
		: providers;
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
		if (attempt.kind === "provider-capacity-block") {
			await attempt.discard?.();
			return { block: attempt.block, kind: "capacity-block" };
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

function eligiblePoolProviders(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	meta: RequestMeta,
	body: ArrayBuffer | null,
	pool: ResolvedProviderPool,
	manualAccountName: string | undefined,
	teamRequest: TeamRoutingRequest,
): Set<string> {
	const eligibleProviders = new Set<string>();
	for (const candidate of pool.providers) {
		const candidateContext = createResolvedProxyContext(
			ctx,
			candidate.provider,
			pool.upstreamPath,
		);
		const prepared = prepareProxyRequest(
			req,
			url,
			candidateContext,
			{ ...meta, model: candidate.model },
			body,
			manualAccountName,
			teamRequest,
			candidate.model,
			{ allowRevalidationProbe: false, applyTeamRouting: false },
		);
		if (prepared.request.thread || prepared.accounts.length === 0) continue;
		const accounts = candidateContext.teamRouter
			? candidateContext.teamRouter.eligibleAccounts(
					prepared.accounts,
					teamRequest,
					candidateContext.runtime.teamRouting,
				)
			: prepared.accounts;
		if (accounts.length > 0) eligibleProviders.add(candidate.provider.name);
	}
	return eligibleProviders;
}

function eligiblePoolChoices(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	meta: RequestMeta,
	body: ArrayBuffer | null,
	pool: ResolvedProviderPool,
	manualAccountName: string | undefined,
	teamRequest: TeamRoutingRequest,
	blockedProvider: string,
): ReturnType<typeof capacityChoices> {
	return capacityChoices(
		pool.providers.map((candidate) => ({
			model: candidate.model ?? meta.model ?? "",
			provider: candidate.provider.name,
		})),
		blockedProvider,
		eligiblePoolProviders(
			req,
			url,
			ctx,
			meta,
			body,
			pool,
			manualAccountName,
			teamRequest,
		),
	);
}

function eligibleHigherPoolChoices(
	pool: ResolvedProviderPool,
	selectedProvider: string,
	eligibleProviders: ReadonlySet<string>,
	routing: ConversationProviderRouting,
	conversationKey: string,
	now: number,
): ProviderChoice[] {
	const selectedIndex = pool.providers.findIndex(
		(candidate) => candidate.provider.name === selectedProvider,
	);
	if (selectedIndex <= 0) return [];
	return pool.providers.slice(0, selectedIndex).flatMap((candidate) => {
		if (!eligibleProviders.has(candidate.provider.name)) return [];
		if (
			!routing.canOfferProvider(conversationKey, candidate.provider.name, now)
		) {
			return [];
		}
		return [
			{
				model: candidate.model ?? "",
				provider: candidate.provider.name,
			},
		];
	});
}

export async function proxyProviderPool(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	meta: RequestMeta,
	body: ArrayBuffer | null,
	pool: ResolvedProviderPool,
	manualAccountName?: string,
	callerId?: string,
	providerWaited = false,
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
		callerId,
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
	const conversationKey = firstContext.teamRouter?.getConversationPinKey(
		teamRequest,
		firstContext.runtime.teamRouting,
		firstContext.provider,
	);
	const routing = new ConversationProviderRouting(
		new PoolConversationProviderRoutingStore(ctx.dbOps),
	);
	let providerPreference = conversationKey
		? routing.getPreference(conversationKey)
		: null;
	const interactive = interactiveProviderChoiceRequested(req.headers);
	const manualChoice =
		interactive && manualProviderChoiceRequested(req.headers);
	if (
		interactive &&
		conversationKey &&
		providerPreference &&
		providerPromotionDeclined(req.headers)
	) {
		routing.declinePromotion(conversationKey, Date.now());
		providerPreference = routing.getPreference(conversationKey);
	}
	const requestedChoice = interactive
		? req.headers.get("x-agent-smith-provider-choice")
		: null;
	const configuredChoices = pool.providers.map((candidate) => ({
		model: candidate.model ?? meta.model ?? "",
		provider: candidate.provider.name,
	}));
	if (requestedChoice && !readProviderChoice(req.headers, configuredChoices)) {
		return new Response("Selected provider is not available for this request", {
			status: 409,
		});
	}
	if (manualChoice) {
		const ordered = preferProvider(
			preferPinnedProvider(pool, pinnedAccount),
			providerPreference?.provider,
		);
		const activeProvider =
			ordered[0]?.provider.name ?? firstCandidate.provider.name;
		const eligible = eligiblePoolProviders(
			req,
			url,
			ctx,
			meta,
			body,
			pool,
			manualAccountName,
			teamRequest,
		);
		return createProviderChoiceProblem({
			activeProvider,
			choices: configuredChoices.filter((choice) =>
				eligible.has(choice.provider),
			),
		});
	}
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

	const candidates = requestedChoice
		? pool.providers.filter(
				(candidate) => candidate.provider.name === requestedChoice,
			)
		: interactive
			? preferProvider(
					preferPinnedProvider(pool, pinnedAccount),
					providerPreference?.provider,
				).slice(0, 1)
			: preferPinnedProvider(pool, pinnedAccount).slice(0, 2);
	if (
		interactive &&
		providerWaitRequested(req.headers) &&
		!providerWaited &&
		candidates[0]
	) {
		const blocked = conversationKey
			? routing.getBlock(conversationKey, candidates[0].provider.name)
			: null;
		const retryAt = blocked?.retryAt;
		const holdMs = firstContext.runtime.teamRouting.holdSeconds * 1_000;
		if (
			ctx.quotaHold &&
			retryAt !== undefined &&
			retryAt > Date.now() &&
			holdMs > 0 &&
			retryAt - Date.now() <= holdMs
		) {
			await ctx.quotaHold.waitUntil(retryAt, req.signal);
			return await proxyProviderPool(
				req,
				url,
				ctx,
				meta,
				body,
				pool,
				manualAccountName,
				callerId,
				true,
			);
		}
		if (retryAt === undefined || retryAt > Date.now()) {
			return createProviderCapacityProblem({
				blockedProvider: candidates[0].provider.name,
				category: (blocked?.category ??
					"unknown") as ProviderCapacityBlock["category"],
				choices: eligiblePoolChoices(
					req,
					url,
					ctx,
					meta,
					body,
					pool,
					manualAccountName,
					teamRequest,
					candidates[0].provider.name,
				),
				...(retryAt !== undefined && { retryAt }),
			});
		}
	}
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
		if (result.kind === "capacity-block") {
			if (conversationKey) {
				routing.recordBlock(
					conversationKey,
					candidate.provider.name,
					result.block,
					Date.now(),
				);
			}
			return createProviderCapacityProblem({
				blockedProvider: candidate.provider.name,
				category: result.block.category,
				choices: eligiblePoolChoices(
					req,
					url,
					ctx,
					meta,
					body,
					pool,
					manualAccountName,
					teamRequest,
					candidate.provider.name,
				),
				...(result.block.retryAt !== undefined && {
					retryAt: result.block.retryAt,
				}),
			});
		}
		if (result.kind === "response") {
			if (result.account) {
				if (conversationKey) {
					routing.clearBlock(conversationKey, candidate.provider.name);
				}
				if (conversationKey && requestedChoice) {
					routing.selectProvider(
						conversationKey,
						candidate.provider.name,
						Date.now(),
					);
				}
				candidateContext.teamRouter?.rebind(
					teamRequest,
					result.account.id,
					candidateContext.runtime.teamRouting,
					candidateContext.provider,
					candidateContext.dbOps,
				);
			}
			if (!interactive) return result.response;
			const served = withServedProviderHeaders(result.response, {
				model: candidate.model ?? meta.model ?? "",
				provider: candidate.provider.name,
			});
			if (
				!conversationKey ||
				!providerPreference ||
				providerPreference.promotionDeclined ||
				requestedChoice ||
				providerPreference.provider !== candidate.provider.name
			) {
				return served;
			}
			return withProviderPromotionDetails(
				served,
				eligibleHigherPoolChoices(
					pool,
					candidate.provider.name,
					eligiblePoolProviders(
						req,
						url,
						ctx,
						meta,
						body,
						pool,
						manualAccountName,
						teamRequest,
					),
					routing,
					conversationKey,
					Date.now(),
				),
			);
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
	if (interactive) {
		const blockedProvider = candidates[0]?.provider.name;
		if (blockedProvider) {
			return createProviderCapacityProblem({
				blockedProvider,
				category: "unknown",
				choices: eligiblePoolChoices(
					req,
					url,
					ctx,
					meta,
					body,
					pool,
					manualAccountName,
					teamRequest,
					blockedProvider,
				),
				...(soonestRetry !== null && { retryAt: soonestRetry }),
			});
		}
	}
	if (soonestRetry !== null) return quotaExhaustionResponse(soonestRetry);
	log.warn(ERROR_MESSAGES.NO_ELIGIBLE_ACCOUNT);
	throw new ServiceUnavailableError(
		ERROR_MESSAGES.NO_ELIGIBLE_ACCOUNT,
		`pool:${pool.wire}`,
	);
}
