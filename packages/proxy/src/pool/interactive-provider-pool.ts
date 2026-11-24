import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import type { ResolvedProviderPool } from "@agent-smith/providers";
import {
	type ConversationProviderRouting,
	capacityChoices,
	createProviderCapacityProblem,
	createProviderChoiceProblem,
	interactiveProviderChoiceRequested,
	type ProviderChoice,
	preferProviders,
	providerWaitRequested,
} from "@agent-smith/routing";
import type { Account, RequestMeta } from "@agent-smith/types";
import {
	createResolvedProxyContext,
	type ProxyContext,
	type ResolvedProxyContext,
} from "../handlers";
import { prepareProxyRequest } from "../handlers/proxy-request";
import {
	hasOrderedProviderFallback,
	type TeamRoutingRequest,
} from "../team-router";

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

/**
 * Allowlisted seats, plus API-key accounts when a person picks the provider in
 * Claude Code's chooser or the device walks the pool under `caller_provider_fallback`.
 */
export function admittedPoolAccounts(
	accounts: Account[],
	context: ResolvedProxyContext,
	{ req, teamRequest }: Pick<InteractivePoolRequest, "req" | "teamRequest">,
): Account[] {
	const pooled = context.teamRouter
		? context.teamRouter.eligibleAccounts(
				accounts,
				teamRequest,
				context.runtime.teamRouting,
			)
		: accounts;
	const reachesApiKeyAccounts =
		interactiveProviderChoiceRequested(req.headers) ||
		hasOrderedProviderFallback(
			context.runtime.teamRouting,
			teamRequest.callerId,
		);
	if (!reachesApiKeyAccounts) return pooled;
	return accounts.filter(
		(account) => account.auth_method === "api_key" || pooled.includes(account),
	);
}

export function eligiblePoolProviders(
	input: InteractivePoolRequest,
): Set<string> {
	const { body, ctx, manualAccountName, meta, pool, req, teamRequest, url } =
		input;
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
		const accounts = admittedPoolAccounts(
			prepared.accounts,
			candidateContext,
			input,
		);
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
	const ordered = preferProviders(
		input.pool.providers,
		(candidate) => candidate.provider.name,
		pinnedAccount?.provider,
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
