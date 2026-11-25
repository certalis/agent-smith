import type {
	ProviderCapacityBlock,
	RoutedProvider,
	RouteRequest,
	ServeOutcome,
} from "@agent-smith/capacity";
import {
	type ConversationProviderPreference,
	ConversationProviderRouting,
	type ConversationProviderRoutingStore,
} from "./conversation-provider-routing";
import {
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
} from "./provider-choice";
import {
	higherRankedProviderChoices,
	preferProviders,
	selectPoolProviders,
} from "./provider-selection";

type Input = {
	route: RouteRequest;
	providers: readonly RoutedProvider[];
	headers: Headers;
	orderedFallback: boolean;
	teamRoutingEnabled: boolean;
	apiKeyAccounts?: "everyone" | "chooser_or_fallback";
	conversationKey?: string;
	holdSeconds?: number;
	waitUntil?: (time: number, signal: AbortSignal) => Promise<void>;
	onRouteFull?: (resetAt: number) => void;
	onDirectFull?: () => void;
	noEligible: () => Response;
	allFailed?: (attempts: number) => Response;
};

type PoolRoute = {
	input: Input;
	choices: ProviderChoice[];
	candidates: RoutedProvider[];
	interactive: boolean;
	requested: string | null;
	preference: ConversationProviderPreference | null;
};
type ExhaustedFacts = {
	firstBlock: ProviderCapacityBlock | undefined;
	soonestRetry: number | null;
	soonestFleetReset: number | null;
	everyFull: boolean;
};

export class Router {
	private readonly routing: ConversationProviderRouting;
	constructor(store: ConversationProviderRoutingStore) {
		this.routing = new ConversationProviderRouting(store);
	}

	async route(input: Input): Promise<Response> {
		if (input.route.scope.kind === "direct") return this.direct(input);
		const prepared = await this.preparePoolRoute(input);
		if (prepared instanceof Response) return prepared;
		const waiting = await this.waitForProvider(prepared);
		if (waiting) return waiting;
		return this.serveCandidates(prepared);
	}

	private async preparePoolRoute(input: Input): Promise<PoolRoute | Response> {
		const { route, providers, headers, conversationKey } = input;
		const interactive = interactiveProviderChoiceRequested(headers);
		route.apiKeyAccounts = input.apiKeyAccounts
			? input.apiKeyAccounts === "everyone" ||
				interactive ||
				input.orderedFallback
			: !input.teamRoutingEnabled || interactive || input.orderedFallback;
		const choices = providers.map((provider) => ({
			provider: provider.name,
			model: provider.mapModel(route.model) ?? route.model ?? "",
		}));
		const affinities = await Promise.all(
			providers.map((provider) => provider.conversationAffinity(route)),
		);
		const pinnedProvider = providers.find(
			(_, index) => affinities[index]?.holdsConversation,
		)?.name;
		let preference = conversationKey
			? this.routing.getPreference(conversationKey)
			: null;
		if (
			interactive &&
			conversationKey &&
			preference &&
			providerPromotionDeclined(headers)
		) {
			this.routing.declinePromotion(conversationKey, Date.now());
			preference = this.routing.getPreference(conversationKey);
		}
		const requested = interactive
			? headers.get("x-agent-smith-provider-choice")
			: null;
		if (requested && !readProviderChoice(headers, choices))
			return new Response(
				"Selected provider is not available for this request",
				{ status: 409 },
			);
		if (interactive && manualProviderChoiceRequested(headers)) {
			const ordered = preferProviders(
				providers,
				(provider) => provider.name,
				pinnedProvider,
				preference?.provider,
			);
			const eligible = await this.availableProviders(input);
			return createProviderChoiceProblem({
				activeProvider: ordered[0]?.name ?? "",
				choices: choices.filter((choice) => eligible.has(choice.provider)),
			});
		}
		const candidates = selectPoolProviders(
			providers,
			(provider) => provider.name,
			{
				orderedFallback: !interactive && input.orderedFallback,
				pinnedProvider,
				hasUnmappedPin:
					!pinnedProvider &&
					affinities.some((affinity) => affinity.hasConversationPin),
				preferredProvider: preference?.provider,
				requestedProvider: requested,
			},
		);
		return { input, choices, candidates, interactive, requested, preference };
	}

	private async availableProviders(input: Input): Promise<Set<string>> {
		const snapshots = await Promise.all(
			input.providers.map((provider) => provider.availability(input.route)),
		);
		return new Set(
			input.providers.flatMap((provider, index) => {
				const snapshot = snapshots[index];
				return snapshot &&
					!snapshot.threadRequest &&
					snapshot.capacity.state !== "blocked"
					? [provider.name]
					: [];
			}),
		);
	}

	private async eligibleChoices(state: PoolRoute, blocked: string) {
		return capacityChoices(
			state.choices,
			blocked,
			await this.availableProviders(state.input),
		);
	}

	private async waitForProvider(state: PoolRoute): Promise<Response | null> {
		const { input, candidates, interactive } = state;
		const first = candidates[0];
		if (!interactive || !providerWaitRequested(input.headers) || !first)
			return null;
		const block = input.conversationKey
			? this.routing.getBlock(input.conversationKey, first.name)
			: null;
		const retryAt = block?.retryAt;
		const now = Date.now();
		if (
			retryAt !== undefined &&
			retryAt > now &&
			(await waitWithin(input, retryAt))
		) {
			const headers = new Headers(input.headers);
			headers.delete("x-agent-smith-provider-wait");
			return this.route({ ...input, headers });
		}
		if (retryAt === undefined || retryAt > now)
			return createProviderCapacityProblem({
				blockedProvider: first.name,
				category: block?.category ?? "unknown",
				choices: await this.eligibleChoices(state, first.name),
				...(retryAt !== undefined && { retryAt }),
			});
		return null;
	}

	private async serveCandidates(state: PoolRoute): Promise<Response> {
		const { input, candidates } = state;
		const unserved: Array<{
			provider: RoutedProvider;
			result: Extract<ServeOutcome, { kind: "exhausted" }>;
		}> = [];
		for (const [index, provider] of candidates.entries()) {
			const result = await provider.serve(input.route);
			if (result.kind === "final")
				return this.servedResponse(state, provider, result);
			if (
				result.reason === "capacity-block" &&
				result.block &&
				input.conversationKey
			)
				this.routing.recordBlock(
					input.conversationKey,
					provider.name,
					result.block,
					Date.now(),
				);
			if (
				result.reason !== "no-eligible-account" &&
				index === candidates.length - 1
			) {
				if (result.reason === "capacity-block" && result.block) {
					await result.discard?.();
					return createProviderCapacityProblem({
						blockedProvider: provider.name,
						category: result.block.category,
						choices: await this.eligibleChoices(state, provider.name),
						...(result.block.retryAt !== undefined && {
							retryAt: result.block.retryAt,
						}),
					});
				}
				return result.forward
					? await result.forward()
					: new Response("Bad Gateway", { status: 502 });
			}
			await result.discard?.();
			unserved.push({ provider, result });
		}
		return this.exhaustedResponse(
			state,
			await this.exhaustedFacts(input.route, unserved),
		);
	}

	private async exhaustedFacts(
		route: RouteRequest,
		unserved: Array<{
			provider: RoutedProvider;
			result: Extract<ServeOutcome, { kind: "exhausted" }>;
		}>,
	): Promise<ExhaustedFacts> {
		let firstBlock: ProviderCapacityBlock | undefined;
		let soonestRetry: number | null = null;
		let soonestFleetReset: number | null = null;
		let everyFull = true;
		for (const { provider, result } of unserved) {
			const needsCapacity =
				result.retryAt === undefined ||
				result.fleetFull === undefined ||
				result.fleetResetAt === undefined;
			const capacity = needsCapacity
				? (await provider.availability(route)).capacity
				: undefined;
			const blocked = capacity?.state === "blocked" ? capacity : undefined;
			firstBlock ??= result.block ?? blocked?.block;
			const retry =
				result.retryAt !== undefined
					? result.retryAt
					: (blocked?.block.retryAt ?? result.block?.retryAt ?? null);
			if (retry !== null && (soonestRetry === null || retry < soonestRetry))
				soonestRetry = retry;
			const reset =
				result.fleetResetAt !== undefined
					? result.fleetResetAt
					: (blocked?.fleetResetAt ?? null);
			if (
				reset !== null &&
				(soonestFleetReset === null || reset < soonestFleetReset)
			)
				soonestFleetReset = reset;
			everyFull &&= result.fleetFull ?? blocked?.fleetFull ?? false;
		}
		return {
			firstBlock,
			soonestRetry,
			soonestFleetReset,
			everyFull,
		};
	}

	private async servedResponse(
		state: PoolRoute,
		provider: RoutedProvider,
		result: Extract<ServeOutcome, { kind: "final" }>,
	): Promise<Response> {
		const { input, interactive, preference, requested, choices } = state;
		const { conversationKey, route } = input;
		if (result.providerServed && conversationKey) {
			this.routing.clearBlock(conversationKey, provider.name);
			if (requested)
				this.routing.selectProvider(conversationKey, provider.name, Date.now());
		}
		if (!interactive) return result.response;
		const served = withServedProviderHeaders(result.response, {
			provider: provider.name,
			model: provider.mapModel(route.model) ?? route.model ?? "",
		});
		if (
			!conversationKey ||
			!preference ||
			preference.promotionDeclined ||
			requested ||
			preference.provider !== provider.name
		)
			return served;
		return withProviderPromotionDetails(
			served,
			higherRankedProviderChoices(
				choices,
				provider.name,
				await this.availableProviders(input),
				(name) =>
					this.routing.canOfferProvider(conversationKey, name, Date.now()),
			),
		);
	}

	private async exhaustedResponse(
		state: PoolRoute,
		facts: ExhaustedFacts,
	): Promise<Response> {
		const { input, interactive, candidates } = state;
		const { firstBlock, soonestRetry, soonestFleetReset, everyFull } = facts;
		if (everyFull && soonestFleetReset !== null)
			input.onRouteFull?.(soonestFleetReset);
		const first = candidates[0];
		if (interactive && first)
			return createProviderCapacityProblem({
				blockedProvider: first.name,
				category: firstBlock?.category ?? "unknown",
				choices: await this.eligibleChoices(state, first.name),
				...((firstBlock?.retryAt ?? soonestRetry) != null && {
					retryAt: firstBlock?.retryAt ?? soonestRetry ?? undefined,
				}),
			});
		if (soonestRetry !== null) return quotaExhaustionResponse(soonestRetry);
		return input.noEligible();
	}

	private async direct(input: Input): Promise<Response> {
		const provider = input.providers[0];
		if (!provider) return input.noEligible();
		input.route.apiKeyAccounts = input.apiKeyAccounts
			? input.apiKeyAccounts === "everyone"
			: !input.teamRoutingEnabled;
		let result = await provider.serve(input.route);
		if (
			result.kind === "exhausted" &&
			result.reason === "no-eligible-account"
		) {
			input.onDirectFull?.();
			const retryAt =
				result.retryAt !== undefined ? result.retryAt : result.block?.retryAt;
			if (retryAt !== undefined && retryAt !== null) {
				if (await waitWithin(input, retryAt)) {
					result = await provider.serve(input.route);
				}
				if (
					result.kind === "exhausted" &&
					result.reason === "no-eligible-account"
				)
					return quotaExhaustionResponse(retryAt);
			}
			if (
				result.kind === "exhausted" &&
				result.reason === "no-eligible-account"
			)
				return input.noEligible();
		}
		if (result.kind === "final") return result.response;
		if (result.forward) return result.forward();
		if (result.reason === "transport")
			return new Response("Bad Gateway", { status: 502 });
		return (
			input.allFailed?.(result.attemptedAccounts ?? 0) ??
			new Response("Bad Gateway", { status: 502 })
		);
	}
}

async function waitWithin(input: Input, retryAt: number): Promise<boolean> {
	if (
		!input.waitUntil ||
		(input.holdSeconds ?? 0) <= 0 ||
		retryAt - Date.now() > (input.holdSeconds ?? 0) * 1000
	)
		return false;
	await input.waitUntil(retryAt, input.route.signal);
	return true;
}

function quotaExhaustionResponse(resetAt: number): Response {
	return new Response("All pooled accounts are out of quota", {
		status: 429,
		headers: {
			"retry-after": String(
				Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
			),
		},
	});
}

/** Aggregates provider capacity only over the route this caller may reach. */
export async function getCallerPoolStatus(input: {
	route: RouteRequest;
	providers: readonly RoutedProvider[];
	orderedFallback: boolean;
	apiKeyAccounts?: boolean;
	teamRoutingEnabled: boolean;
	holdSeconds: number;
	admissionWaitMs: number;
}) {
	const first = input.providers[0];
	if (!first || input.route.scope.kind !== "pool-route") return null;
	const reachable = !input.teamRoutingEnabled
		? []
		: input.orderedFallback
			? input.providers
			: [first];
	input.route.apiKeyAccounts = input.apiKeyAccounts ?? input.orderedFallback;
	const statuses = await Promise.all(
		reachable.map((provider) => provider.status(input.route)),
	);
	const eligibleAccounts = statuses.reduce(
		(sum, status) => sum + status.servableSeats,
		0,
	);
	const retryTimes = statuses.flatMap((status) =>
		status.retryAt === null ? [] : [status.retryAt],
	);
	return {
		version: 1 as const,
		pool: input.route.scope.wire,
		provider: first.name,
		routingEnabled: input.teamRoutingEnabled,
		eligibleAccounts,
		retryAtMs:
			eligibleAccounts === 0 && retryTimes.length
				? Math.min(...retryTimes)
				: null,
		holdSeconds: input.holdSeconds,
		admissionWaitMs: input.admissionWaitMs,
	};
}
