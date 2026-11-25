import type { RoutedProvider, ServeOutcome } from "@agent-smith/capacity";
import { Logger } from "@agent-smith/logger";
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
	getProviderCallerStatus,
	getQuotaCapacityBlock,
	getSoonestQuotaReset,
	isEveryAccountQuotaBlocked,
	isServableNow,
} from "./handlers/account-selector";
import {
	getThreadBoundAccountId,
	parseMessageThreadRequest,
} from "./handlers/message-thread";
import { alertWhenFleetFull } from "./seat-alerts";
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

export type SupplySessionExecutor = (
	route: import("@agent-smith/capacity").RouteRequest,
	request: PoolAttemptRequest,
	account: Account,
) => Promise<object>;

/** Per-provider seat state and upstream executor, shared across requests. */
export class ProviderSupply implements RoutedProvider {
	private readonly preparedRoutes = new WeakMap<
		import("@agent-smith/capacity").RouteRequest,
		{ request: PoolAttemptRequest; accounts: Account[] }
	>();
	readonly name: string;
	readonly wire: import("@agent-smith/types").ProviderWire;

	constructor(
		private readonly provider: import("@agent-smith/providers").Provider,
		private readonly context: import("./pool-context").PoolContext,
		private readonly options: {
			mapModel: (model: string | undefined) => string | undefined | null;
			createExecutor: SupplyExecutorFactory;
			createSessionAttempt?: SupplySessionExecutor;
		},
	) {
		this.name = provider.name;
		this.wire = provider.wire;
	}

	setSessionExecutor(executor: SupplySessionExecutor): void {
		this.options.createSessionAttempt ??= executor;
	}

	supportsConversationPins(): boolean {
		return this.context.teamRouter !== undefined;
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
			this.provider.getClientSessionId?.(route.edge.headers) ?? null,
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

	/** Temporary adapter for the existing proxy's hold and provider-selection flow. */
	prepareRoute(route: import("@agent-smith/capacity").RouteRequest): {
		hasAccounts: boolean;
		attemptedAccounts: number;
		block: import("@agent-smith/capacity").ProviderCapacityBlock | null;
		retryAt: number | null;
		fleetFull: boolean;
		fleetResetAt: number | null;
	} {
		if (
			route.scope.kind === "pool-route" &&
			this.mapModel(route.model) === null
		) {
			return {
				hasAccounts: false,
				attemptedAccounts: 0,
				block: null,
				retryAt: null,
				fleetFull: false,
				fleetResetAt: null,
			};
		}
		const prepared = this.prepare(route);
		this.preparedRoutes.set(route, prepared);
		const { accounts } = prepared;
		if (accounts.length > 0)
			return {
				hasAccounts: true,
				attemptedAccounts: accounts.length,
				block: null,
				retryAt: null,
				fleetFull: false,
				fleetResetAt: null,
			};
		return {
			hasAccounts: false,
			attemptedAccounts: 0,
			...this.unservedFacts(route),
		};
	}

	unservedFacts(route: import("@agent-smith/capacity").RouteRequest): {
		block: import("@agent-smith/capacity").ProviderCapacityBlock | null;
		retryAt: number | null;
		fleetFull: boolean;
		fleetResetAt: number | null;
	} {
		const ctx = this.contextFor(route);
		const teamRequest = this.teamRequestFor(route);
		const model =
			route.scope.kind === "pool-route"
				? (this.mapModel(route.model) ?? undefined)
				: route.model;
		const meta = { ...route.edge.meta, model };
		const thread = parseMessageThreadRequest(
			route.edge.body,
			ctx.upstreamPath,
			route.edge.headers.get("content-type"),
			this.provider.getClientSessionId?.(route.edge.headers) ?? null,
		);
		const threadAccount = getThreadBoundAccountId(ctx.messageThreads, thread);
		const seatsFor = (fleet: Account[]) => {
			const eligible =
				ctx.teamRouter?.eligibleAccounts(
					fleet,
					teamRequest,
					ctx.runtime.teamRouting,
				) ?? fleet;
			return threadAccount
				? eligible.filter((account) => account.id === threadAccount)
				: eligible;
		};
		return {
			block: getQuotaCapacityBlock(meta, ctx, seatsFor, route.callerId),
			retryAt: getSoonestQuotaReset(meta, ctx, seatsFor, route.callerId),
			fleetFull: isEveryAccountQuotaBlocked(meta, ctx),
			fleetResetAt: getSoonestQuotaReset(meta, ctx),
		};
	}

	alertFleetFull(
		route: import("@agent-smith/capacity").RouteRequest,
		holdSeconds: number,
	): void {
		alertWhenFleetFull(route.edge.meta, this.contextFor(route), holdSeconds);
	}

	alertAllFull(scope: string, resetAt: number): void {
		this.context.seatAlerts?.allAccountsFull(scope, resetAt, {
			blocked: true,
			holdSeconds: 0,
		});
	}

	/** Provider holding the existing seat pin, without exposing the seat. */
	holdingProvider(
		route: import("@agent-smith/capacity").RouteRequest,
	): string | undefined {
		const ctx = this.contextFor(route);
		const pinnedId = ctx.teamRouter?.getPinnedAccountId(
			this.teamRequestFor(route),
			ctx.runtime.teamRouting,
			ctx.provider,
			ctx.dbOps,
		);
		return pinnedId ? ctx.dbOps.getAccount(pinnedId)?.provider : undefined;
	}

	async availability(
		route: import("@agent-smith/capacity").RouteRequest,
	): Promise<import("@agent-smith/capacity").Availability> {
		const ctx = this.contextFor(route);
		const teamRequest = this.teamRequestFor(route);
		const mappedModel =
			route.scope.kind === "pool-route"
				? this.mapModel(route.model)
				: route.model;
		const model = mappedModel === null ? undefined : mappedModel;
		const meta = { ...route.edge.meta, model };
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
		const thread = parseMessageThreadRequest(
			route.edge.body,
			ctx.upstreamPath,
			route.edge.headers.get("content-type"),
			this.provider.getClientSessionId?.(route.edge.headers) ?? null,
		);
		const threadRequest = thread !== null;
		const threadAccount = getThreadBoundAccountId(ctx.messageThreads, thread);
		const seatsFor = (fleet: Account[]) => {
			const eligible =
				ctx.teamRouter?.eligibleAccounts(
					fleet,
					teamRequest,
					ctx.runtime.teamRouting,
				) ?? fleet;
			return threadAccount
				? eligible.filter((account) => account.id === threadAccount)
				: eligible;
		};
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
						model,
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
		const block = getQuotaCapacityBlock(meta, ctx, seatsFor, route.callerId);
		return {
			capacity: block
				? {
						state: "blocked",
						block,
						fleetFull: isEveryAccountQuotaBlocked(meta, ctx),
						fleetResetAt: getSoonestQuotaReset(meta, ctx),
					}
				: { state: "unknown" },
			holdsConversation,
			threadRequest,
		};
	}

	async status(
		route: import("@agent-smith/capacity").RouteRequest,
	): Promise<import("@agent-smith/capacity").ProviderStatus> {
		const mapped =
			route.scope.kind === "pool-route"
				? this.mapModel(route.model)
				: route.model;
		if (mapped === null)
			return {
				servableSeats: 0,
				retryAt: null,
				admissionWaitMs: this.context.runtime.teamRouting.admissionWaitMs,
			};
		if (route.scope.kind === "pool-route" && route.callerId) {
			return getProviderCallerStatus(
				this.name,
				mapped,
				route.callerId,
				this.context,
				route.apiKeyAccounts,
			);
		}
		const snapshot = getPoolStatus(this.name, mapped, this.context);
		return {
			servableSeats: snapshot.eligibleAccounts,
			retryAt: snapshot.retryAtMs,
			admissionWaitMs: snapshot.admissionWaitMs,
		};
	}

	async openSession(
		route: import("@agent-smith/capacity").RouteRequest,
	): Promise<import("@agent-smith/capacity").SessionOutcome> {
		const createAttempt = this.options.createSessionAttempt;
		if (!createAttempt) return { kind: "unavailable", reason: "not-supported" };
		const { request, accounts } = this.prepare(route);
		if (accounts.length === 0)
			return { kind: "unavailable", reason: "no-eligible-account" };
		let nextIndex = 0;
		let closed = false;
		const log = new Logger("WebSocketProxy");
		return {
			kind: "prepared",
			session: {
				close() {
					closed = true;
				},
				async next() {
					while (
						!closed &&
						!route.signal.aborted &&
						nextIndex < accounts.length
					) {
						const account = accounts[nextIndex] as Account;
						nextIndex += 1;
						try {
							const handle = await createAttempt(route, request, account);
							if (closed || route.signal.aborted) return null;
							return { handle, attemptNumber: nextIndex };
						} catch (error) {
							log.warn(
								"Skipping websocket account during upstream connection",
								{
									account: account.name,
									error: error instanceof Error ? error.message : String(error),
								},
							);
						}
					}
					return null;
				},
			},
		};
	}

	async serve(
		route: import("@agent-smith/capacity").RouteRequest,
	): Promise<ServeOutcome> {
		if (
			route.scope.kind === "pool-route" &&
			this.mapModel(route.model) === null
		) {
			return { kind: "exhausted", reason: "no-eligible-account" };
		}
		const prepared = this.preparedRoutes.get(route) ?? this.prepare(route);
		this.preparedRoutes.delete(route);
		const { request, accounts } = prepared;
		if (accounts.length > 0) {
			route.beforeAttempt?.();
			new Logger("Proxy").info(
				`Selected ${accounts.length} accounts: ${accounts.map((account) => account.name).join(", ")}`,
			);
		}
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
		const threadAccount = getThreadBoundAccountId(
			request.ctx.messageThreads,
			request.thread,
		);
		const seatsFor = (fleet: Account[]) => {
			const eligible =
				request.ctx.teamRouter?.eligibleAccounts(
					fleet,
					request.teamRequest,
					request.ctx.runtime.teamRouting,
				) ?? fleet;
			return threadAccount
				? eligible.filter((account) => account.id === threadAccount)
				: eligible;
		};
		const block = getQuotaCapacityBlock(
			request.meta,
			request.ctx,
			seatsFor,
			route.callerId,
		);
		return block ? { ...outcome, block } : outcome;
	}
}
