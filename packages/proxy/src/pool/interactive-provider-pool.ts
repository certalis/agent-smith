import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import type { ResolvedProviderPool } from "@agent-smith/providers";
import {
	type ConversationProviderRouting,
	capacityChoices,
	createProviderCapacityProblem,
	createProviderChoiceProblem,
	type ProviderChoice,
	preferProviders,
	providerWaitRequested,
} from "@agent-smith/routing";
import type { RequestMeta } from "@agent-smith/types";
import { createResolvedProxyContext, type ProxyContext } from "../handlers";
import { buildRouteRequest } from "../handlers/proxy-request";
import { getProviderSupply } from "../supply-executor";
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

export async function poolAvailability(
	input: InteractivePoolRequest,
	candidate: ResolvedProviderPool["providers"][number],
) {
	const context = createResolvedProxyContext(
		input.ctx,
		candidate.provider,
		input.pool.upstreamPath,
	);
	const route = buildRouteRequest(
		input.req,
		input.url,
		context,
		input.meta,
		input.body,
		input.teamRequest,
		"pool-route",
	);
	return await getProviderSupply(input.ctx, candidate.provider).availability(
		route,
	);
}

export async function eligiblePoolProviders(
	input: InteractivePoolRequest,
): Promise<Set<string>> {
	const availability = await Promise.all(
		input.pool.providers.map((candidate) => poolAvailability(input, candidate)),
	);
	return new Set(
		input.pool.providers.flatMap((candidate, index) => {
			const state = availability[index];
			return state &&
				!state.threadRequest &&
				state.capacity.state === "available"
				? [candidate.provider.name]
				: [];
		}),
	);
}

export async function eligiblePoolChoices(
	input: InteractivePoolRequest,
	blockedProvider: string,
): Promise<ProviderChoice[]> {
	return capacityChoices(
		configuredPoolChoices(input.pool, input.meta.model),
		blockedProvider,
		await eligiblePoolProviders(input),
	);
}

export async function createManualProviderChoiceResponse(
	input: InteractivePoolRequest,
	pinnedProvider: string | undefined,
	preferredProvider: string | undefined,
): Promise<Response> {
	const ordered = preferProviders(
		input.pool.providers,
		(candidate) => candidate.provider.name,
		pinnedProvider,
		preferredProvider,
	);
	const activeProvider =
		ordered[0]?.provider.name ?? input.pool.providers[0]?.provider.name ?? "";
	const eligible = await eligiblePoolProviders(input);
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
			choices: await eligiblePoolChoices(input, provider),
			...(retryAt !== undefined && { retryAt }),
		});
	}
	return null;
}
