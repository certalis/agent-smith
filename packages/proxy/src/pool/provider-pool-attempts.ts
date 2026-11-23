import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import { requestEvents } from "@agent-smith/core";
import { Logger } from "@agent-smith/logger";
import type { ResolvedProviderPool } from "@agent-smith/providers";
import {
	type ConversationProviderPreference,
	type ConversationProviderRouting,
	createProviderCapacityProblem,
	higherRankedProviderChoices,
	withProviderPromotionDetails,
	withServedProviderHeaders,
} from "@agent-smith/routing";
import type { Account } from "@agent-smith/types";
import {
	createResolvedProxyContext,
	getSoonestQuotaReset,
	isEveryAccountQuotaBlocked,
} from "../handlers";
import {
	attemptAccount,
	discardAttempt,
	resolvePerMinuteRateLimit,
	resolveQuotaRateLimit,
	resolveRequestScopedRateLimit,
	resolveTransportFailure,
	resolveUpstreamFailure,
} from "../handlers/proxy-attempts";
import {
	getRequestQuotaCapacityBlock,
	getRequestRetryAt,
	type ProxyRequest,
	prepareProxyRequest,
} from "../handlers/proxy-request";
import {
	configuredPoolChoices,
	eligiblePoolChoices,
	eligiblePoolProviders,
	type InteractivePoolRequest,
} from "./interactive-provider-pool";

const log = new Logger("Proxy");

type PoolCandidateResult =
	| { block: ProviderCapacityBlock; kind: "capacity-block" }
	| { kind: "next-provider" }
	| { account?: Account; kind: "response"; response: Response };

type ProviderPoolCandidateInput = {
	candidates: ResolvedProviderPool["providers"];
	conversationKey: string | undefined;
	interactive: boolean;
	interactiveInput: InteractivePoolRequest;
	pinnedId: string | undefined;
	providerPreference: ConversationProviderPreference | null;
	requestedChoice: string | null;
	routing: ConversationProviderRouting;
};

type ResolvedPoolCandidate = ResolvedProviderPool["providers"][number];

export type ProviderPoolCandidateAttempt =
	| { kind: "response"; response: Response }
	| {
			everyCandidateFull: boolean;
			firstCapacityBlock: ProviderCapacityBlock | null;
			kind: "unserved";
			soonestFleetReset: number | null;
			soonestRetry: number | null;
	  };

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
			if (accounts[index + 1]) continue;
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

function resolvePoolCandidateResult({
	candidate,
	candidateContext,
	conversationKey,
	interactive,
	interactiveInput,
	providerPreference,
	requestedChoice,
	result,
	routing,
}: {
	candidate: ResolvedPoolCandidate;
	candidateContext: ReturnType<typeof createResolvedProxyContext>;
	conversationKey: string | undefined;
	interactive: boolean;
	interactiveInput: InteractivePoolRequest;
	providerPreference: ConversationProviderPreference | null;
	requestedChoice: string | null;
	result: PoolCandidateResult;
	routing: ConversationProviderRouting;
}): Response | null {
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
			choices: eligiblePoolChoices(interactiveInput, candidate.provider.name),
			...(result.block.retryAt !== undefined && {
				retryAt: result.block.retryAt,
			}),
		});
	}
	if (result.kind !== "response") return null;
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
			interactiveInput.teamRequest,
			result.account.id,
			candidateContext.runtime.teamRouting,
			candidateContext.provider,
			candidateContext.dbOps,
		);
	}
	if (!interactive) return result.response;
	const served = withServedProviderHeaders(result.response, {
		model: candidate.model ?? interactiveInput.meta.model ?? "",
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
		higherRankedProviderChoices(
			configuredPoolChoices(interactiveInput.pool, interactiveInput.meta.model),
			candidate.provider.name,
			eligiblePoolProviders(interactiveInput),
			(provider) =>
				routing.canOfferProvider(conversationKey, provider, Date.now()),
		),
	);
}

function preparePoolCandidate(
	input: InteractivePoolRequest,
	candidate: ResolvedPoolCandidate,
	pinnedId: string | undefined,
): {
	accounts: Account[];
	context: ReturnType<typeof createResolvedProxyContext>;
	request: ProxyRequest;
} {
	const context = createResolvedProxyContext(
		input.ctx,
		candidate.provider,
		input.pool.upstreamPath,
	);
	const prepared = prepareProxyRequest(
		input.req,
		input.url,
		context,
		{ ...input.meta, model: candidate.model },
		input.body,
		input.manualAccountName,
		input.teamRequest,
		candidate.model,
		{ allowRevalidationProbe: false, applyTeamRouting: false },
	);
	const eligibleAccounts = context.teamRouter
		? context.teamRouter.eligibleAccounts(
				prepared.accounts,
				input.teamRequest,
				context.runtime.teamRouting,
			)
		: prepared.accounts;
	return {
		accounts: preferPinnedAccount(eligibleAccounts, pinnedId),
		context,
		request: prepared.request,
	};
}

export async function proxyPoolCandidates({
	candidates,
	conversationKey,
	interactive,
	interactiveInput,
	pinnedId,
	providerPreference,
	requestedChoice,
	routing,
}: ProviderPoolCandidateInput): Promise<ProviderPoolCandidateAttempt> {
	let soonestRetry: number | null = null;
	let soonestFleetReset: number | null = null;
	let everyCandidateFull = true;
	let firstCapacityBlock: ProviderCapacityBlock | null = null;
	let emittedIngress = false;
	const earliest = (current: number | null, next: number | null) =>
		next !== null && (current === null || next < current) ? next : current;
	const recordUnserved = (request: ProxyRequest) => {
		firstCapacityBlock ??= getRequestQuotaCapacityBlock(request);
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

	for (const [candidateIndex, candidate] of candidates.entries()) {
		const { accounts, context, request } = preparePoolCandidate(
			interactiveInput,
			candidate,
			pinnedId,
		);
		if (accounts.length === 0) {
			recordUnserved(request);
			continue;
		}

		if (!emittedIngress) {
			requestEvents.emit("event", {
				type: "ingress",
				id: interactiveInput.meta.id,
				timestamp: interactiveInput.meta.timestamp,
				method: interactiveInput.meta.method,
				path: interactiveInput.meta.path,
			});
			emittedIngress = true;
		}
		log.info(
			`Selected ${accounts.length} accounts: ${accounts.map((account) => account.name).join(", ")}`,
		);
		const result = await proxyPoolCandidate(
			request,
			accounts,
			candidateIndex === 0,
		);
		const response = resolvePoolCandidateResult({
			candidate,
			candidateContext: context,
			conversationKey,
			interactive,
			interactiveInput,
			providerPreference,
			requestedChoice,
			result,
			routing,
		});
		if (response) return { kind: "response", response };
		recordUnserved(request);
	}

	return {
		everyCandidateFull,
		kind: "unserved",
		firstCapacityBlock,
		soonestFleetReset,
		soonestRetry,
	};
}
