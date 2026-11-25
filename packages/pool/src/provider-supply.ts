import type { RoutedProvider, ServeOutcome } from "@agent-smith/capacity";
import type { Account } from "@agent-smith/types";
import {
	attemptAccount,
	discardAttempt,
	resolvePerMinuteRateLimit,
	resolveQuotaRateLimit,
	resolveRequestScopedRateLimit,
	resolveTransportFailure,
	resolveUpstreamFailure,
} from "./account-attempts";
import type { PoolAttemptRequest } from "./attempt-executor";
import {
	getOrderedAccounts,
	getPoolStatus,
	getQuotaCapacityBlock,
	getSoonestQuotaReset,
	isEveryAccountQuotaBlocked,
	isServableNow,
} from "./handlers/account-selector";
import {
	getThreadBoundAccountId,
	parseMessageThreadRequest,
} from "./handlers/message-thread";
import { isAllowlisted } from "./seat-router";

/** Serve one provider without deciding whether the router should try another. */
export async function serveSelectedAccounts(
	request: PoolAttemptRequest,
	accounts: Account[],
	scope: "direct" | "pool-route",
): Promise<ServeOutcome> {
	if (accounts.length === 0)
		return { kind: "exhausted", reason: "no-eligible-account" };
	for (const [index, account] of accounts.entries()) {
		const attempt = await attemptAccount(request, account, index);
		if (attempt.kind === "response") {
			if (scope === "pool-route") {
				request.ctx.teamRouter?.rebind(
					request.teamRequest,
					account.id,
					request.ctx.runtime.teamRouting,
					request.ctx.provider,
					request.ctx.dbOps,
				);
			}
			return {
				kind: "final",
				response: attempt.response,
				providerServed: true,
			};
		}
		if (attempt.kind === "authentication-failure") {
			return {
				kind: "final",
				response: new Response("Bad Gateway", { status: 502 }),
				providerServed: false,
			};
		}
		if (attempt.kind === "provider-capacity-block") {
			if (scope === "pool-route" && accounts[index + 1]) {
				await attempt.discard?.();
				continue;
			}
			return {
				kind: "exhausted",
				reason: "capacity-block",
				block: attempt.block,
				forward: attempt.forward,
				discard: attempt.discard,
			};
		}
		if (attempt.kind === "per-minute-rate-limit") {
			return {
				kind: "final",
				response: await resolvePerMinuteRateLimit(
					request,
					account,
					index,
					attempt,
				),
				providerServed: false,
			};
		}
		if (attempt.kind === "request-scoped-rate-limit") {
			return {
				kind: "final",
				response: await resolveRequestScopedRateLimit(
					request,
					accounts,
					index,
					attempt,
				),
				providerServed: false,
			};
		}
		if (attempt.kind === "quota-rate-limit") {
			if (accounts[index + 1])
				return {
					kind: "final",
					response: await resolveQuotaRateLimit(
						request,
						accounts,
						index,
						attempt,
					),
					providerServed: false,
				};
			return {
				kind: "exhausted",
				reason: "quota",
				forward: attempt.forward,
				discard: attempt.discard,
			};
		}
		if (attempt.kind === "upstream-failure") {
			if (accounts[index + 1])
				return {
					kind: "final",
					response: await resolveUpstreamFailure(
						request,
						accounts,
						index,
						attempt,
					),
					providerServed: false,
				};
			return {
				kind: "exhausted",
				reason: "upstream-failure",
				forward: attempt.forward,
				discard: () => discardAttempt(attempt),
			};
		}
		if (attempt.kind === "transport-failure") {
			if (accounts[index + 1])
				return {
					kind: "final",
					response: await resolveTransportFailure(request, accounts, index),
					providerServed: false,
				};
			return { kind: "exhausted", reason: "transport" };
		}
	}
	return { kind: "exhausted", reason: "all-failed" };
}

export type SupplyExecutorFactory = (
	route: import("@agent-smith/capacity").RouteRequest,
	request: Omit<PoolAttemptRequest, "execute">,
) => import("./attempt-executor").AttemptExecutor;

/** Per-provider seat state and upstream executor, shared across requests. */
export class ProviderSupply implements RoutedProvider {
	readonly name: string;
	readonly wire: import("@agent-smith/types").ProviderWire;

	constructor(
		private readonly provider: import("@agent-smith/providers").Provider,
		private readonly context: import("./pool-context").PoolContext,
		private readonly options: {
			mapModel: (model: string | undefined) => string | undefined | null;
			createExecutor: SupplyExecutorFactory;
		},
	) {
		this.name = provider.name;
		this.wire = provider.wire;
	}

	mapModel(model: string | undefined): string | undefined | null {
		return this.options.mapModel(model);
	}

	private contextFor(route: import("@agent-smith/capacity").RouteRequest) {
		const resolved =
			route.scope.kind === "direct"
				? this.context.providerRegistry.resolveProvider(route.edge.url.pathname)
				: this.context.providerRegistry.resolvePool(
						route.edge.url.pathname,
						route.model,
					);
		return {
			...this.context,
			provider: this.provider,
			providerName: this.name,
			upstreamPath: resolved?.upstreamPath ?? "/",
		};
	}

	private teamRequestFor(
		route: import("@agent-smith/capacity").RouteRequest,
	): import("./seat-router").TeamRoutingRequest {
		return {
			body: route.edge.body,
			callerId: route.callerId,
			contentType: route.edge.headers.get("content-type"),
			manualAccountName: route.seatHint,
			model: route.model,
			lookupOpeningDigest: route.openingDigest,
			provider:
				route.scope.kind === "direct" ? this.name : `pool:${route.scope.wire}`,
			sessionId: route.sessionId,
			...(route.scope.kind === "pool-route" && {
				pinScope: `pool:${route.scope.wire}`,
				pinBucket: route.model,
			}),
		};
	}

	private prepare(route: import("@agent-smith/capacity").RouteRequest): {
		request: PoolAttemptRequest;
		accounts: Account[];
	} {
		const ctx = this.contextFor(route);
		const mappedModel =
			route.scope.kind === "pool-route"
				? (this.mapModel(route.model) ?? undefined)
				: undefined;
		const meta =
			route.scope.kind === "pool-route"
				? { ...route.edge.meta, model: mappedModel }
				: route.edge.meta;
		const teamRequest = this.teamRequestFor(route);
		const thread = parseMessageThreadRequest(
			route.edge.body,
			ctx.upstreamPath,
			route.edge.headers.get("content-type"),
			route.sessionId,
		);
		const req = new Request(route.edge.url, {
			method: route.edge.method,
			headers: route.edge.headers,
			body: route.edge.body,
			signal: route.signal,
		});
		const base = {
			body: route.edge.body,
			ctx,
			mappedModel,
			meta,
			req,
			teamRequest,
			thread,
			url: route.edge.url,
		};
		const request: PoolAttemptRequest = {
			...base,
			execute: this.options.createExecutor(route, base),
		};
		let accounts = getOrderedAccounts(
			meta,
			ctx,
			teamRequest,
			route.scope.kind === "pool-route"
				? { allowRevalidationProbe: false, applyTeamRouting: false }
				: {},
		);
		if (route.scope.kind === "pool-route") {
			const pooled =
				ctx.teamRouter?.eligibleAccounts(
					accounts,
					teamRequest,
					ctx.runtime.teamRouting,
				) ?? accounts;
			accounts = route.apiKeyAccounts
				? accounts.filter(
						(candidate) =>
							candidate.auth_method === "api_key" || pooled.includes(candidate),
					)
				: pooled;
			const pinnedId = ctx.teamRouter?.getPinnedAccountId(
				teamRequest,
				ctx.runtime.teamRouting,
				ctx.provider,
				ctx.dbOps,
			);
			const pinned = accounts.find((candidate) => candidate.id === pinnedId);
			if (pinned)
				accounts = [
					pinned,
					...accounts.filter((candidate) => candidate.id !== pinned.id),
				];
		}
		const threadAccount = getThreadBoundAccountId(ctx.messageThreads, thread);
		if (threadAccount)
			accounts = accounts.filter((candidate) => candidate.id === threadAccount);
		return { request, accounts };
	}

	async availability(
		route: import("@agent-smith/capacity").RouteRequest,
	): Promise<import("@agent-smith/capacity").Availability> {
		const ctx = this.contextFor(route);
		const teamRequest = this.teamRequestFor(route);
		const pinnedId = ctx.teamRouter?.getPinnedAccountId(
			teamRequest,
			ctx.runtime.teamRouting,
			ctx.provider,
			ctx.dbOps,
		);
		const holdsConversation =
			pinnedId !== undefined &&
			ctx.dbOps
				.getAccountsByProvider(this.name)
				.some((account) => account.id === pinnedId);
		const threadRequest =
			parseMessageThreadRequest(
				route.edge.body,
				ctx.upstreamPath,
				route.edge.headers.get("content-type"),
				route.sessionId,
			) !== null;
		const thread = parseMessageThreadRequest(
			route.edge.body,
			ctx.upstreamPath,
			route.edge.headers.get("content-type"),
			route.sessionId,
		);
		const threadAccount = getThreadBoundAccountId(ctx.messageThreads, thread);
		const hasAvailableAccount = ctx.dbOps
			.getAvailableAccountsByProvider(this.name)
			.some((account) => {
				if (threadAccount && account.id !== threadAccount) return false;
				const teamEnabled = ctx.runtime.teamRouting.enabled;
				const pooled =
					!teamEnabled ||
					(isAllowlisted(account, ctx.runtime.teamRouting) &&
						(!route.seatHint || account.name === route.seatHint));
				const keyReached =
					route.scope.kind === "pool-route" &&
					route.apiKeyAccounts &&
					account.auth_method === "api_key";
				return (
					(pooled || keyReached) &&
					isServableNow(
						this.provider,
						account,
						route.model,
						ctx,
						Date.now(),
						route.callerId,
					)
				);
			});
		if (hasAvailableAccount)
			return {
				capacity: { state: "available" },
				holdsConversation,
				threadRequest,
			};
		const block = getQuotaCapacityBlock(
			route.edge.meta,
			ctx,
			undefined,
			route.callerId,
		);
		return {
			capacity: block
				? {
						state: "blocked",
						block,
						fleetFull: isEveryAccountQuotaBlocked(route.edge.meta, ctx),
						fleetResetAt: getSoonestQuotaReset(route.edge.meta, ctx),
					}
				: { state: "unknown" },
			holdsConversation,
			threadRequest,
		};
	}

	async status(
		route: import("@agent-smith/capacity").RouteRequest,
	): Promise<import("@agent-smith/capacity").ProviderStatus> {
		const snapshot = getPoolStatus(this.name, route.model, this.context);
		return {
			servableSeats: snapshot.eligibleAccounts,
			retryAt: snapshot.retryAtMs,
			admissionWaitMs: snapshot.admissionWaitMs,
		};
	}

	/** Compatibility entry point while the proxy still prepares legacy requests. */
	servePrepared(
		request: PoolAttemptRequest,
		accounts: Account[],
		scope: "direct" | "pool-route",
	): Promise<ServeOutcome> {
		return serveSelectedAccounts(request, accounts, scope);
	}

	async serve(
		route: import("@agent-smith/capacity").RouteRequest,
	): Promise<ServeOutcome> {
		const { request, accounts } = this.prepare(route);
		const outcome = await serveSelectedAccounts(
			request,
			accounts,
			route.scope.kind,
		);
		if (
			outcome.kind !== "exhausted" ||
			outcome.reason !== "no-eligible-account"
		)
			return outcome;
		const block = getQuotaCapacityBlock(
			request.meta,
			request.ctx,
			undefined,
			route.callerId,
		);
		return block ? { ...outcome, block } : outcome;
	}
}
