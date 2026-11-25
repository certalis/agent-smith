import type {
	ProviderCapacityBlock,
	RouteRequest,
} from "@agent-smith/capacity";
import { requestEvents } from "@agent-smith/core";
import type { ProviderSupply } from "@agent-smith/pool";
import type { ResolvedProviderPool } from "@agent-smith/providers";
import {
	type ConversationProviderPreference,
	type ConversationProviderRouting,
	createProviderCapacityProblem,
	higherRankedProviderChoices,
	withProviderPromotionDetails,
	withServedProviderHeaders,
} from "@agent-smith/routing";
import { createResolvedProxyContext } from "../handlers";
import { buildRouteRequest } from "../handlers/proxy-request";
import { getProviderSupply } from "../supply-executor";
import {
	configuredPoolChoices,
	eligiblePoolChoices,
	eligiblePoolProviders,
	type InteractivePoolRequest,
} from "./interactive-provider-pool";

type PoolCandidateResult =
	| { block: ProviderCapacityBlock; kind: "capacity-block" }
	| { block?: ProviderCapacityBlock; kind: "next-provider" }
	| { providerServed?: boolean; kind: "response"; response: Response };

type ProviderPoolCandidateInput = {
	candidates: ResolvedProviderPool["providers"];
	conversationKey: string | undefined;
	interactive: boolean;
	interactiveInput: InteractivePoolRequest;
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

async function proxyPoolCandidate(
	supply: ProviderSupply,
	route: RouteRequest,
	allowNextProvider: boolean,
): Promise<PoolCandidateResult> {
	const result = await supply.serve(route);
	if (result.kind === "final")
		return {
			kind: "response",
			response: result.response,
			providerServed: result.providerServed,
		};
	if (result.reason === "capacity-block" && result.block) {
		await result.discard?.();
		return allowNextProvider
			? { kind: "next-provider", block: result.block }
			: { kind: "capacity-block", block: result.block };
	}
	if (allowNextProvider) {
		await result.discard?.();
		return { kind: "next-provider" };
	}
	return {
		kind: "response",
		response: result.forward
			? await result.forward()
			: new Response("Bad Gateway", { status: 502 }),
	};
}

async function resolvePoolCandidateResult({
	candidate,
	conversationKey,
	interactive,
	interactiveInput,
	providerPreference,
	requestedChoice,
	result,
	routing,
}: {
	candidate: ResolvedPoolCandidate;
	conversationKey: string | undefined;
	interactive: boolean;
	interactiveInput: InteractivePoolRequest;
	providerPreference: ConversationProviderPreference | null;
	requestedChoice: string | null;
	result: PoolCandidateResult;
	routing: ConversationProviderRouting;
}): Promise<Response | null> {
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
			choices: await eligiblePoolChoices(
				interactiveInput,
				candidate.provider.name,
			),
			...(result.block.retryAt !== undefined && {
				retryAt: result.block.retryAt,
			}),
		});
	}
	if (result.kind !== "response") return null;
	if (result.providerServed) {
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
			await eligiblePoolProviders(interactiveInput),
			(provider) =>
				routing.canOfferProvider(conversationKey, provider, Date.now()),
		),
	);
}

function preparePoolCandidate(
	input: InteractivePoolRequest,
	candidate: ResolvedPoolCandidate,
	beforeAttempt: () => void,
) {
	const context = createResolvedProxyContext(
		input.ctx,
		candidate.provider,
		input.pool.upstreamPath,
	);
	const supply = getProviderSupply(input.ctx, candidate.provider);
	const route = buildRouteRequest(
		input.req,
		input.url,
		context,
		input.meta,
		input.body,
		input.teamRequest,
		"pool-route",
		beforeAttempt,
	);
	return { supply, route, prepared: supply.prepareRoute(route) };
}

export async function proxyPoolCandidates({
	candidates,
	conversationKey,
	interactive,
	interactiveInput,
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
	const recordUnserved = (
		facts: ReturnType<ProviderSupply["unservedFacts"]>,
	) => {
		firstCapacityBlock ??= facts.block;
		everyCandidateFull &&= facts.fleetFull;
		soonestRetry = earliest(soonestRetry, facts.retryAt);
		soonestFleetReset = earliest(soonestFleetReset, facts.fleetResetAt);
	};
	const beforeAttempt = () => {
		if (emittedIngress) return;
		requestEvents.emit("event", {
			type: "ingress",
			id: interactiveInput.meta.id,
			timestamp: interactiveInput.meta.timestamp,
			method: interactiveInput.meta.method,
			path: interactiveInput.meta.path,
		});
		emittedIngress = true;
	};

	for (const [candidateIndex, candidate] of candidates.entries()) {
		const { supply, route, prepared } = preparePoolCandidate(
			interactiveInput,
			candidate,
			beforeAttempt,
		);
		if (!prepared.hasAccounts) {
			recordUnserved(prepared);
			continue;
		}
		const result = await proxyPoolCandidate(
			supply,
			route,
			candidateIndex < candidates.length - 1,
		);
		if (result.kind === "next-provider" && result.block) {
			firstCapacityBlock ??= result.block;
			if (conversationKey)
				routing.recordBlock(
					conversationKey,
					candidate.provider.name,
					result.block,
					Date.now(),
				);
		}
		const response = await resolvePoolCandidateResult({
			candidate,
			conversationKey,
			interactive,
			interactiveInput,
			providerPreference,
			requestedChoice,
			result,
			routing,
		});
		if (response) return { kind: "response", response };
		recordUnserved(supply.unservedFacts(route));
	}

	return {
		everyCandidateFull,
		kind: "unserved",
		firstCapacityBlock,
		soonestFleetReset,
		soonestRetry,
	};
}
