import { ServiceUnavailableError } from "@agent-smith/core";
import { Logger } from "@agent-smith/logger";
import type { ResolvedProviderPool } from "@agent-smith/providers";
import {
	ConversationProviderRouting,
	createProviderCapacityProblem,
	interactiveProviderChoiceRequested,
	manualProviderChoiceRequested,
	providerPromotionDeclined,
	readProviderChoice,
	selectPoolProviders,
} from "@agent-smith/routing";
import type { RequestMeta } from "@agent-smith/types";
import {
	createResolvedProxyContext,
	ERROR_MESSAGES,
	type ProxyContext,
} from "./handlers";
import { quotaExhaustionResponse } from "./handlers/proxy-attempts";
import { PoolConversationProviderRoutingStore } from "./pool/conversation-provider-routing-store";
import {
	configuredPoolChoices,
	createManualProviderChoiceResponse,
	eligiblePoolChoices,
	type InteractivePoolRequest,
	waitOrReturnProviderCapacity,
} from "./pool/interactive-provider-pool";
import { proxyPoolCandidates } from "./pool/provider-pool-attempts";
import type { TeamRoutingRequest } from "./team-router";

const log = new Logger("Proxy");

type ProviderPoolSelection = {
	candidates: ResolvedProviderPool["providers"];
	conversationKey: string | undefined;
	interactive: boolean;
	interactiveInput: InteractivePoolRequest;
	kind: "selection";
	pinnedId: string | undefined;
	providerPreference: ReturnType<ConversationProviderRouting["getPreference"]>;
	requestedChoice: string | null;
	routing: ConversationProviderRouting;
};

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

function prepareProviderPoolSelection(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	meta: RequestMeta,
	body: ArrayBuffer | null,
	pool: ResolvedProviderPool,
	manualAccountName: string | undefined,
	callerId: string | undefined,
): { kind: "response"; response: Response } | ProviderPoolSelection {
	const firstCandidate = pool.providers[0];
	if (!firstCandidate) {
		return {
			kind: "response",
			response: new Response(
				`No provider in provider_pools.${pool.wire} serves the requested model`,
				{ status: 400 },
			),
		};
	}
	const teamRequest = poolTeamRequest(
		req,
		body,
		pool,
		meta.model,
		manualAccountName,
		callerId,
	);
	const interactiveInput: InteractivePoolRequest = {
		body,
		ctx,
		manualAccountName,
		meta,
		pool,
		req,
		teamRequest,
		url,
	};
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
	const configuredChoices = configuredPoolChoices(pool, meta.model);
	if (requestedChoice && !readProviderChoice(req.headers, configuredChoices)) {
		return {
			kind: "response",
			response: new Response(
				"Selected provider is not available for this request",
				{ status: 409 },
			),
		};
	}
	if (interactive && manualProviderChoiceRequested(req.headers)) {
		return {
			kind: "response",
			response: createManualProviderChoiceResponse(
				interactiveInput,
				pinnedAccount,
				providerPreference?.provider,
			),
		};
	}
	return {
		candidates: selectPoolProviders(
			pool.providers,
			(candidate) => candidate.provider.name,
			{
				interactive,
				pinnedProvider: pinnedAccount?.provider,
				preferredProvider: providerPreference?.provider,
				requestedProvider: requestedChoice,
			},
		),
		conversationKey,
		interactive,
		interactiveInput,
		kind: "selection",
		pinnedId,
		providerPreference,
		requestedChoice,
		routing,
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
	callerId?: string,
	providerWaited = false,
): Promise<Response> {
	const selection = prepareProviderPoolSelection(
		req,
		url,
		ctx,
		meta,
		body,
		pool,
		manualAccountName,
		callerId,
	);
	if (selection.kind === "response") return selection.response;
	const {
		candidates,
		conversationKey,
		interactive,
		interactiveInput,
		pinnedId,
		providerPreference,
		requestedChoice,
		routing,
	} = selection;
	if (interactive) {
		const waitResponse = await waitOrReturnProviderCapacity({
			candidates,
			conversationKey,
			input: interactiveInput,
			providerWaited,
			retry: () =>
				proxyProviderPool(
					req,
					url,
					ctx,
					meta,
					body,
					pool,
					manualAccountName,
					callerId,
					true,
				),
			routing,
		});
		if (waitResponse) return waitResponse;
	}
	const candidateAttempt = await proxyPoolCandidates({
		candidates,
		conversationKey,
		interactive,
		interactiveInput,
		pinnedId,
		providerPreference,
		requestedChoice,
		routing,
	});
	if (candidateAttempt.kind === "response") return candidateAttempt.response;

	if (
		candidateAttempt.everyCandidateFull &&
		candidateAttempt.soonestFleetReset !== null
	) {
		ctx.seatAlerts?.allAccountsFull(
			`provider_pools.${pool.wire}`,
			candidateAttempt.soonestFleetReset,
			{ blocked: true, holdSeconds: 0 },
		);
	}
	if (interactive) {
		const blockedProvider = candidates[0]?.provider.name;
		if (blockedProvider) {
			const block = candidateAttempt.firstCapacityBlock;
			const retryAt = block?.retryAt ?? candidateAttempt.soonestRetry;
			return createProviderCapacityProblem({
				blockedProvider,
				category: block?.category ?? "unknown",
				choices: eligiblePoolChoices(interactiveInput, blockedProvider),
				...(retryAt !== null &&
					retryAt !== undefined && {
						retryAt,
					}),
			});
		}
	}
	if (candidateAttempt.soonestRetry !== null) {
		return quotaExhaustionResponse(candidateAttempt.soonestRetry);
	}
	log.warn(ERROR_MESSAGES.NO_ELIGIBLE_ACCOUNT);
	throw new ServiceUnavailableError(
		ERROR_MESSAGES.NO_ELIGIBLE_ACCOUNT,
		`pool:${pool.wire}`,
	);
}
