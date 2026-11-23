import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import type { ResolvedProviderPool } from "@agent-smith/providers";
import {
	type ConversationProviderRouting,
	capacityChoices,
	createProviderCapacityProblem,
	createProviderChoiceProblem,
	type ProviderChoice,
	providerWaitRequested,
	withProviderPromotionDetails,
} from "@agent-smith/routing";
import type { Account, RequestMeta } from "@agent-smith/types";
import { createResolvedProxyContext, type ProxyContext } from "../handlers";
import { prepareProxyRequest } from "../handlers/proxy-request";
import type { TeamRoutingRequest } from "../team-router";

export type InteractivePoolRequest = {
	body: ArrayBuffer | null;
	ctx: ProxyContext;
	manualAccountName: string | undefined;
	meta: RequestMeta;
	pool: ResolvedProviderPool;
	req: Request;
	teamRequest: TeamRoutingRequest;
	url: URL;
};

export function configuredPoolChoices(
	pool: ResolvedProviderPool,
	fallbackModel: string | undefined,
): ProviderChoice[] {
	return pool.providers.map((candidate) => ({
		model: candidate.model ?? fallbackModel ?? "",
		provider: candidate.provider.name,
	}));
}

export function preferInteractivePoolProviders(
	pool: ResolvedProviderPool,
	pinnedAccount: Account | null,
	preferredProvider: string | undefined,
): ResolvedProviderPool["providers"] {
	const pinned = pinnedAccount
		? [
				...pool.providers.filter(
					(candidate) => candidate.provider.name === pinnedAccount.provider,
				),
				...pool.providers.filter(
					(candidate) => candidate.provider.name !== pinnedAccount.provider,
				),
			]
		: pool.providers;
	if (!preferredProvider) return pinned;
	return [
		...pinned.filter(
			(candidate) => candidate.provider.name === preferredProvider,
		),
		...pinned.filter(
			(candidate) => candidate.provider.name !== preferredProvider,
		),
	];
}

export function eligiblePoolProviders({
	body,
	ctx,
	manualAccountName,
	meta,
	pool,
	req,
	teamRequest,
	url,
}: InteractivePoolRequest): Set<string> {
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

export function eligiblePoolChoices(
	input: InteractivePoolRequest,
	blockedProvider: string,
): ProviderChoice[] {
	return capacityChoices(
		configuredPoolChoices(input.pool, input.meta.model),
		blockedProvider,
		eligiblePoolProviders(input),
	);
}

export function createManualProviderChoiceResponse(
	input: InteractivePoolRequest,
	pinnedAccount: Account | null,
	preferredProvider: string | undefined,
): Response {
	const ordered = preferInteractivePoolProviders(
		input.pool,
		pinnedAccount,
		preferredProvider,
	);
	const activeProvider =
		ordered[0]?.provider.name ?? input.pool.providers[0]?.provider.name ?? "";
	const eligible = eligiblePoolProviders(input);
	return createProviderChoiceProblem({
		activeProvider,
		choices: configuredPoolChoices(input.pool, input.meta.model).filter(
			(choice) => eligible.has(choice.provider),
		),
	});
}

export async function waitOrReturnProviderCapacity({
	candidates,
	conversationKey,
	input,
	providerWaited,
	retry,
	routing,
}: {
	candidates: ResolvedProviderPool["providers"];
	conversationKey: string | undefined;
	input: InteractivePoolRequest;
	providerWaited: boolean;
	retry: () => Promise<Response>;
	routing: ConversationProviderRouting;
}): Promise<Response | null> {
	if (
		!providerWaitRequested(input.req.headers) ||
		providerWaited ||
		!candidates[0]
	) {
		return null;
	}
	const provider = candidates[0].provider.name;
	const blocked = conversationKey
		? routing.getBlock(conversationKey, provider)
		: null;
	const retryAt = blocked?.retryAt;
	const holdMs = input.ctx.runtime.teamRouting.holdSeconds * 1_000;
	if (
		input.ctx.quotaHold &&
		retryAt !== undefined &&
		retryAt > Date.now() &&
		holdMs > 0 &&
		retryAt - Date.now() <= holdMs
	) {
		await input.ctx.quotaHold.waitUntil(retryAt, input.req.signal);
		return await retry();
	}
	if (retryAt === undefined || retryAt > Date.now()) {
		return createProviderCapacityProblem({
			blockedProvider: provider,
			category: (blocked?.category ??
				"unknown") as ProviderCapacityBlock["category"],
			choices: eligiblePoolChoices(input, provider),
			...(retryAt !== undefined && { retryAt }),
		});
	}
	return null;
}

export function withEligibleProviderPromotion({
	conversationKey,
	input,
	response,
	routing,
	selectedProvider,
}: {
	conversationKey: string;
	input: InteractivePoolRequest;
	response: Response;
	routing: ConversationProviderRouting;
	selectedProvider: string;
}): Response {
	const selectedIndex = input.pool.providers.findIndex(
		(candidate) => candidate.provider.name === selectedProvider,
	);
	if (selectedIndex <= 0) return response;
	const eligible = eligiblePoolProviders(input);
	const choices = input.pool.providers
		.slice(0, selectedIndex)
		.flatMap((candidate) => {
			if (!eligible.has(candidate.provider.name)) return [];
			if (
				!routing.canOfferProvider(
					conversationKey,
					candidate.provider.name,
					Date.now(),
				)
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
	return withProviderPromotionDetails(response, choices);
}
