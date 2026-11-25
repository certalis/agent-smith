import type {
	Availability,
	ProviderStatus,
	RoutedProvider,
	RouteRequest,
	ServeOutcome,
	SessionOutcome,
} from "@agent-smith/capacity";
import { runtimeForProvider } from "@agent-smith/config";
import { Logger } from "@agent-smith/logger";
import type { Provider } from "@agent-smith/providers";
import type { Account, ProviderWire } from "@agent-smith/types";
import {
	attemptAccount,
	discardAttempt,
	resolvePerMinuteRateLimit,
	resolveQuotaRateLimit,
	resolveRequestScopedRateLimit,
	resolveTransportFailure,
	resolveUpstreamFailure,
} from "./account-attempts";
import type { AttemptExecutor, PoolAttemptRequest } from "./attempt-executor";
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
	type MessageThreadRequest,
	parseMessageThreadRequest,
} from "./handlers/message-thread";
import type { PoolContext, ResolvedPoolContext } from "./pool-context";
import { isAllowlisted, type TeamRoutingRequest } from "./seat-router";

// Provider candidates share the body, but their session identifiers can differ.
const threadBodies = new WeakMap<
	RouteRequest,
	Map<string, { continues: string | null } | null>
>();
const conversationPins = new WeakMap<
	PoolContext,
	WeakMap<RouteRequest, string | null>
>();

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
	route: RouteRequest,
	request: Omit<PoolAttemptRequest, "execute">,
) => AttemptExecutor;

export type SupplySessionExecutor = (
	route: RouteRequest,
	request: PoolAttemptRequest,
	account: Account,
) => Promise<object>;

/** Per-provider seat state and upstream executor, shared across requests. */
export class ProviderSupply implements RoutedProvider {
	readonly name: string;
	readonly wire: ProviderWire;

	constructor(
		private readonly provider: Provider,
		private readonly context: PoolContext,
		private readonly options: {
			mapModel: (model: string | undefined) => string | undefined | null;
			createExecutor: SupplyExecutorFactory;
			createSessionAttempt?: SupplySessionExecutor;
		},
	) {
		this.name = provider.name;
		this.wire = provider.wire;
	}

	mapModel(model: string | undefined): string | undefined | null {
		return this.options.mapModel(model);
	}

	private contextFor(route: RouteRequest) {
		const resolved =
			route.scope.kind === "direct"
				? this.context.providerRegistry.resolveProvider(route.edge.url.pathname)
				: this.context.providerRegistry.resolvePool(
						route.edge.url.pathname,
						route.model,
					);
		return {
			...this.context,
			runtime: runtimeForProvider(this.context.runtime, this.name),
			provider: this.provider,
			providerName: this.name,
			upstreamPath: resolved?.upstreamPath ?? "/",
		};
	}

	/** A request's thread and eligible seats, evaluated only when needed. */
	private requestView(
		route: RouteRequest,
		prepared?: PoolAttemptRequest,
		context?: ResolvedPoolContext,
	) {
		const ctx = prepared?.ctx ?? context ?? this.contextFor(route);
		const teamRequest: TeamRoutingRequest = prepared?.teamRequest ?? {
			body: route.edge.body,
			callerId: route.callerId,
			contentType: route.edge.headers.get("content-type"),
			manualAccountName: route.seatHint,
			apiKeyAccounts: route.scope.kind === "direct" && route.apiKeyAccounts,
			model: route.model,
			lookupOpeningDigest: route.openingDigest,
			seatPinLookup: route,
			provider:
				route.scope.kind === "direct" ? this.name : `pool:${route.scope.wire}`,
			sessionId: route.sessionId,
			...(route.scope.kind === "pool-route" && {
				pinScope: `pool:${route.scope.wire}`,
				pinBucket: route.model,
			}),
		};
		let thread: MessageThreadRequest | null | undefined = prepared
			? prepared.thread
			: undefined;
		let bound = false;
		let threadAccount: string | null = null;
		const getThread = () => {
			if (thread === undefined) {
				const sessionId =
					this.provider.getClientSessionId?.(route.edge.headers) ?? null;
				if (!sessionId) return null;
				let byPath = threadBodies.get(route);
				if (!byPath) {
					byPath = new Map();
					threadBodies.set(route, byPath);
				}
				if (!byPath.has(ctx.upstreamPath)) {
					const parsed = parseMessageThreadRequest(
						route.edge.body,
						ctx.upstreamPath,
						route.edge.headers.get("content-type"),
						sessionId,
					);
					byPath.set(
						ctx.upstreamPath,
						parsed ? { continues: parsed.continues } : null,
					);
				}
				const parsed = byPath.get(ctx.upstreamPath);
				thread = parsed ? { ...parsed, sessionId } : null;
			}
			return thread;
		};
		const getThreadAccount = () => {
			if (!bound) {
				threadAccount = getThreadBoundAccountId(
					ctx.messageThreads,
					getThread(),
				);
				bound = true;
			}
			return threadAccount;
		};
		const seatsFor = (fleet: Account[]) => {
			const eligible =
				ctx.teamRouter?.eligibleAccounts(
					fleet,
					teamRequest,
					ctx.runtime.teamRouting,
				) ?? fleet;
			const id = getThreadAccount();
			return id ? eligible.filter((account) => account.id === id) : eligible;
		};
		return { ctx, teamRequest, getThread, getThreadAccount, seatsFor };
	}

	private prepare(route: RouteRequest): {
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
		const view = this.requestView(route, undefined, ctx);
		const teamRequest = view.teamRequest;
		const thread = view.getThread();
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
		if (!route.apiKeyAccounts)
			accounts = accounts.filter(
				(candidate) => candidate.auth_method !== "api_key",
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
		const threadAccount = view.getThreadAccount();
		if (threadAccount)
			accounts = accounts.filter((candidate) => candidate.id === threadAccount);
		return { request, accounts };
	}

	async conversationAffinity(
		route: RouteRequest,
	): Promise<{ holdsConversation: boolean; hasConversationPin: boolean }> {
		const view = this.requestView(route);
		if (!view.ctx.runtime.teamRouting.enabled)
			return { holdsConversation: false, hasConversationPin: false };
		let pins = conversationPins.get(this.context);
		if (!pins) {
			pins = new WeakMap();
			conversationPins.set(this.context, pins);
		}
		if (!pins.has(route)) {
			const { ctx, teamRequest } = view;
			const pinnedId = ctx.teamRouter?.getPinnedAccountId(
				teamRequest,
				ctx.runtime.teamRouting,
				ctx.provider,
				ctx.dbOps,
			);
			pins.set(
				route,
				pinnedId ? (ctx.dbOps.getAccount?.(pinnedId)?.provider ?? null) : null,
			);
		}
		const provider = pins.get(route);
		return {
			holdsConversation: provider === this.name,
			hasConversationPin: !!provider,
		};
	}

	async availability(route: RouteRequest): Promise<Availability> {
		const view = this.requestView(route);
		const { ctx, seatsFor } = view;
		const mappedModel =
			route.scope.kind === "pool-route"
				? this.mapModel(route.model)
				: route.model;
		const model = mappedModel === null ? undefined : mappedModel;
		const meta = { ...route.edge.meta, model };
		const { holdsConversation, hasConversationPin } =
			await this.conversationAffinity(route);
		const threadRequest = view.getThread() !== null;
		const threadAccount = view.getThreadAccount();
		const hasAvailableAccount = ctx.dbOps
			.getAvailableAccountsByProvider(this.name)
			.some((account) => {
				if (threadAccount && account.id !== threadAccount) return false;
				const teamEnabled = ctx.runtime.teamRouting.enabled;
				const pooled =
					account.auth_method !== "api_key" &&
					(!teamEnabled ||
						(isAllowlisted(account, ctx.runtime.teamRouting) &&
							(!route.seatHint || account.name === route.seatHint)));
				const keyReached =
					route.apiKeyAccounts && account.auth_method === "api_key";
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
				hasConversationPin,
				threadRequest,
			};
		const block = getQuotaCapacityBlock(meta, ctx, seatsFor, route.callerId);
		return {
			capacity: {
				state: "blocked",
				block: block ?? { category: "unknown" },
				fleetFull: isEveryAccountQuotaBlocked(meta, ctx),
				fleetResetAt: getSoonestQuotaReset(meta, ctx),
			},
			holdsConversation,
			hasConversationPin,
			threadRequest,
		};
	}

	async status(route: RouteRequest): Promise<ProviderStatus> {
		const context = {
			...this.context,
			runtime: runtimeForProvider(this.context.runtime, this.name),
		};
		const mapped =
			route.scope.kind === "pool-route"
				? this.mapModel(route.model)
				: route.model;
		if (mapped === null)
			return {
				servableSeats: 0,
				retryAt: null,
				admissionWaitMs: context.runtime.teamRouting.admissionWaitMs,
			};
		if (route.scope.kind === "pool-route" && route.callerId) {
			return getProviderCallerStatus(
				this.name,
				mapped,
				route.callerId,
				context,
				route.apiKeyAccounts,
			);
		}
		const snapshot = getPoolStatus(this.name, mapped, context);
		return {
			servableSeats: snapshot.eligibleAccounts,
			retryAt: snapshot.retryAtMs,
			admissionWaitMs: snapshot.admissionWaitMs,
		};
	}

	async openSession(route: RouteRequest): Promise<SessionOutcome> {
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

	async serve(route: RouteRequest): Promise<ServeOutcome> {
		if (
			route.scope.kind === "pool-route" &&
			this.mapModel(route.model) === null
		) {
			return { kind: "exhausted", reason: "no-eligible-account" };
		}
		const prepared = this.prepare(route);
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
		if (outcome.kind !== "exhausted") return outcome;
		const view = this.requestView(route, request);
		view.getThreadAccount();
		const block = getQuotaCapacityBlock(
			request.meta,
			request.ctx,
			view.seatsFor,
			route.callerId,
		);
		return {
			...outcome,
			block: outcome.block ?? block ?? undefined,
			retryAt: getSoonestQuotaReset(
				request.meta,
				request.ctx,
				view.seatsFor,
				route.callerId,
			),
			fleetFull: isEveryAccountQuotaBlocked(request.meta, request.ctx),
			fleetResetAt: getSoonestQuotaReset(request.meta, request.ctx),
			attemptedAccounts: accounts.length,
		};
	}
}
