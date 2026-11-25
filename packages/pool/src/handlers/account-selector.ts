import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import type { Provider } from "@agent-smith/providers";
import {
	type Account,
	type AccountProvider,
	isCurrentQuotaWindow,
	isOpenQuotaWindow,
	type PoolStatus,
	quotaThresholdFor,
	type RequestMeta,
} from "@agent-smith/types";
import type { PoolContext, ResolvedPoolContext } from "../pool-context";
import { isAllowlisted, type TeamRoutingRequest } from "../seat-router";
import { soonestWeeklyReset } from "../seat-usage";
import { refreshBackoffUntil } from "./token-manager";

type EligibilityContext = Pick<PoolContext, "runtime" | "dbOps">;
type SeatPolicyContext = {
	runtime: Pick<PoolContext["runtime"], "quotaThreshold" | "teamRouting">;
	dbOps: Pick<PoolContext["dbOps"], "getEnrollmentContact">;
};
type PoolStatusContext = Pick<
	PoolContext,
	"runtime" | "dbOps" | "providerRegistry"
>;

const QUOTA_PROBE_INTERVAL_MS = 60_000;

type PoolUsageCap = {
	limit: number;
	overridesFleetThreshold: boolean;
};

export type AccountSelectionOptions = {
	allowRevalidationProbe?: boolean;
	applyTeamRouting?: boolean;
};

function isQuotaBlocking(
	provider: Provider,
	account: Account,
	bucket: string,
	window: NonNullable<Account["quota_state"]>["windows"][string],
	fleetThreshold: number,
	now: number,
	model: string | undefined,
	maxUsage: PoolUsageCap | undefined,
): boolean {
	const accountThreshold =
		account.switch_threshold === null || account.switch_threshold === undefined
			? undefined
			: quotaThresholdFor(account, bucket, fleetThreshold);
	const threshold =
		maxUsage?.overridesFleetThreshold === true
			? Math.min(maxUsage.limit, accountThreshold ?? Number.POSITIVE_INFINITY)
			: Math.min(
					quotaThresholdFor(account, bucket, fleetThreshold),
					maxUsage?.limit ?? Number.POSITIVE_INFINITY,
				);
	return (
		(provider.quotaBucketsFor(model)?.includes(bucket) ?? true) &&
		(maxUsage === undefined
			? isCurrentQuotaWindow(window, now)
			: isOpenQuotaWindow(window, now)) &&
		(window.status === "rejected" ||
			(window.utilization !== null && window.utilization >= threshold))
	);
}

function pooledMaxUsage(
	provider: Provider,
	account: Account,
	bucket: string,
	ctx: SeatPolicyContext,
	callerId?: string,
): PoolUsageCap | undefined {
	const teamRouting = ctx.runtime.teamRouting;
	if (teamRouting?.enabled !== true || !isAllowlisted(account, teamRouting))
		return undefined;
	if (!provider.isWeeklyBucket(bucket)) {
		return { limit: teamRouting.maxUsage, overridesFleetThreshold: false };
	}
	const email = ctx.dbOps
		.getEnrollmentContact(account.id)
		?.email?.trim()
		.toLowerCase();
	const accountOverride = email
		? teamRouting.weeklyMaxUsageByEmail[email]
		: undefined;
	const callerOverride =
		callerId && Object.hasOwn(teamRouting.callerWeeklyMaxUsage, callerId)
			? teamRouting.callerWeeklyMaxUsage[callerId]
			: undefined;
	return {
		limit: Math.min(
			accountOverride ?? teamRouting.weeklyMaxUsage,
			callerOverride ?? Number.POSITIVE_INFINITY,
		),
		overridesFleetThreshold: accountOverride !== undefined,
	};
}

function isQuotaEligible(
	provider: Provider,
	account: Account,
	fleetThreshold: number,
	now: number,
	model: string | undefined,
	ctx: SeatPolicyContext,
	callerId?: string,
): boolean {
	const quota = account.quota_state;
	if (!quota) return true;

	for (const [name, window] of Object.entries(quota.windows)) {
		if (
			isQuotaBlocking(
				provider,
				account,
				name,
				window,
				fleetThreshold,
				now,
				model,
				pooledMaxUsage(provider, account, name, ctx, callerId),
			)
		) {
			return false;
		}
	}

	return true;
}

/**
 * The seats a full-fleet answer is about: a seat cooling after a per-minute
 * 429 is one of them, a paused or team-routing-excluded seat never serves.
 */
function fleetAccounts(
	provider: AccountProvider,
	ctx: EligibilityContext,
): Account[] {
	return ctx.dbOps
		.getAccountsByProvider(provider)
		.filter((account) => isFleetSeat(account, ctx));
}

function isFleetSeat(account: Account, ctx: SeatPolicyContext): boolean {
	const teamRouting = ctx.runtime.teamRouting;
	return (
		!account.paused &&
		(teamRouting?.enabled !== true || isAllowlisted(account, teamRouting))
	);
}

/**
 * The first millisecond routing serves a cooling seat again:
 * `findAvailableForProvider` keeps it only once `rate_limited_until < now`.
 */
function cooldownEnd(account: Account, now: number): number | null {
	const rateLimitEnd =
		account.rate_limited_until !== null && account.rate_limited_until >= now
			? account.rate_limited_until + 1
			: null;
	const refreshEnd = refreshBackoffUntil(account, now);
	return rateLimitEnd === null
		? refreshEnd
		: Math.max(rateLimitEnd, refreshEnd ?? 0);
}

/** Routing would serve this seat right now: in the fleet, not cooling, under every applicable cap. */
export function isServableSeat(
	provider: Provider,
	account: Account,
	model: string | undefined,
	ctx: SeatPolicyContext,
	now: number,
): boolean {
	return (
		isFleetSeat(account, ctx) &&
		isServableNow(provider, account, model, ctx, now)
	);
}

export function isServableNow(
	provider: Provider,
	account: Account,
	model: string | undefined,
	ctx: SeatPolicyContext,
	now: number,
	callerId?: string,
): boolean {
	return (
		cooldownEnd(account, now) === null &&
		isQuotaEligible(
			provider,
			account,
			ctx.runtime.quotaThreshold,
			now,
			model,
			ctx,
			callerId,
		)
	);
}

/**
 * The accounts a caller's pool request may land on, as pool attempts admit
 * them: allowlisted seats, and API-key accounts under ordered fallback.
 */
function callerPoolAccounts(
	provider: AccountProvider,
	ctx: EligibilityContext,
	orderedFallback: boolean,
): Account[] {
	return ctx.dbOps
		.getAccountsByProvider(provider)
		.filter(
			(account) =>
				isFleetSeat(account, ctx) ||
				(orderedFallback &&
					!account.paused &&
					account.auth_method === "api_key"),
		);
}

function blockingResets(
	provider: Provider,
	account: Account,
	model: string | undefined,
	ctx: EligibilityContext,
	now: number,
	callerId?: string,
): number[] {
	return Object.entries(account.quota_state?.windows ?? {})
		.filter(
			([bucket, window]) =>
				window.resetAt !== null &&
				window.resetAt > now &&
				isQuotaBlocking(
					provider,
					account,
					bucket,
					window,
					ctx.runtime.quotaThreshold,
					now,
					model,
					pooledMaxUsage(provider, account, bucket, ctx, callerId),
				),
		)
		.map(([, window]) => window.resetAt as number);
}

function quotaBlockForAccount(
	provider: Provider,
	account: Account,
	model: string | undefined,
	ctx: EligibilityContext,
	now: number,
	callerId?: string,
): ProviderCapacityBlock | null {
	const blocking = Object.entries(account.quota_state?.windows ?? {}).filter(
		([bucket, window]) =>
			isQuotaBlocking(
				provider,
				account,
				bucket,
				window,
				ctx.runtime.quotaThreshold,
				now,
				model,
				pooledMaxUsage(provider, account, bucket, ctx, callerId),
			),
	);
	if (blocking.length === 0) return null;
	const [bucket, window] = [...blocking].sort(([, left], [, right]) => {
		const leftReset = left.resetAt ?? Number.POSITIVE_INFINITY;
		const rightReset = right.resetAt ?? Number.POSITIVE_INFINITY;
		return rightReset - leftReset;
	})[0] as [string, NonNullable<Account["quota_state"]>["windows"][string]];
	const category = provider.isFiveHourBucket(bucket)
		? "five-hour-limit"
		: provider.isWeeklyBucket(bucket)
			? "weekly-limit"
			: "unknown";
	return window.resetAt === null
		? { category }
		: { category, retryAt: window.resetAt };
}

/**
 * Describes the quota fact that keeps the earliest eligible seat from serving.
 * Generic cooldowns remain a request-rate problem rather than a made-up quota category.
 */
export function getQuotaCapacityBlock(
	meta: RequestMeta,
	ctx: ResolvedPoolContext,
	seatsFor: (fleet: Account[]) => Account[] = (fleet) => fleet,
	callerId?: string,
): ProviderCapacityBlock | null {
	const now = Date.now();
	const blocks = seatsFor(fleetAccounts(ctx.providerName, ctx))
		.map((account) =>
			quotaBlockForAccount(
				ctx.provider,
				account,
				meta.model,
				ctx,
				now,
				callerId,
			),
		)
		.filter((block): block is ProviderCapacityBlock => block !== null);
	if (blocks.length === 0) return null;
	return [...blocks].sort(
		(left, right) =>
			(left.retryAt ?? Number.POSITIVE_INFINITY) -
			(right.retryAt ?? Number.POSITIVE_INFINITY),
	)[0] as ProviderCapacityBlock;
}

/** When this seat serves again: every blocking window reset and its cooldown over. */
function servableAt(
	provider: Provider,
	account: Account,
	model: string | undefined,
	ctx: EligibilityContext,
	now: number,
	callerId?: string,
): number | null {
	const cooldown = cooldownEnd(account, now);
	if (
		isQuotaEligible(
			provider,
			account,
			ctx.runtime.quotaThreshold,
			now,
			model,
			ctx,
			callerId,
		)
	) {
		return cooldown;
	}
	const resets = blockingResets(provider, account, model, ctx, now, callerId);
	return resets.length > 0 ? Math.max(...resets, cooldown ?? 0) : null;
}

/**
 * The soonest any of `seats` serves again. Null when no fleet seat is
 * quota-blocked, so a fleet that is only cooling is not called out of quota.
 */
function soonestServableAt(
	provider: Provider,
	fleet: Account[],
	seats: Account[],
	model: string | undefined,
	ctx: EligibilityContext,
	now: number,
	callerId?: string,
): number | null {
	if (
		!fleet.some(
			(account) =>
				blockingResets(provider, account, model, ctx, now, callerId).length > 0,
		)
	) {
		return null;
	}
	const times = seats.flatMap((account) => {
		const at = servableAt(provider, account, model, ctx, now, callerId);
		return at === null ? [] : [at];
	});
	return times.length > 0 ? Math.min(...times) : null;
}

/** Snapshot only: no admission, conversation pin or revalidation probe is consumed. */
export function getPoolStatus(
	provider: AccountProvider,
	model: string | undefined,
	ctx: PoolStatusContext,
): PoolStatus {
	const providerStrategy = ctx.providerRegistry.getProvider(provider);
	if (!providerStrategy) throw new Error(`Unknown provider '${provider}'`);
	const config = ctx.runtime.teamRouting;
	const now = Date.now();
	const accounts = config?.enabled ? fleetAccounts(provider, ctx) : [];
	const eligibleAccounts = accounts.filter((account) =>
		isServableSeat(providerStrategy, account, model, ctx, now),
	).length;
	return {
		version: 1,
		provider,
		routingEnabled: config?.enabled === true,
		eligibleAccounts,
		retryAtMs:
			eligibleAccounts === 0
				? soonestServableAt(
						providerStrategy,
						accounts,
						accounts,
						model,
						ctx,
						now,
					)
				: null,
		holdSeconds: config?.holdSeconds ?? 0,
		admissionWaitMs: config?.admissionWaitMs ?? 0,
	};
}

/** Factual capacity for one caller on one provider, without routing policy. */
export function getProviderCallerStatus(
	provider: AccountProvider,
	model: string | undefined,
	callerId: string,
	ctx: PoolStatusContext,
	apiKeyAccounts: boolean,
): import("@agent-smith/capacity").ProviderStatus {
	const strategy = ctx.providerRegistry.getProvider(provider);
	if (!strategy) throw new Error(`Unknown provider '${provider}'`);
	const config = ctx.runtime.teamRouting;
	const now = Date.now();
	const accounts = config.enabled
		? callerPoolAccounts(provider, ctx, apiKeyAccounts)
		: [];
	const servableSeats = accounts.filter((account) =>
		isServableNow(strategy, account, model, ctx, now, callerId),
	).length;
	return {
		servableSeats,
		retryAt:
			servableSeats === 0
				? soonestServableAt(
						strategy,
						accounts,
						accounts,
						model,
						ctx,
						now,
						callerId,
					)
				: null,
		admissionWaitMs: config.admissionWaitMs,
	};
}

/**
 * When a request refused for quota may retry. `seatsFor` narrows the fleet to
 * the seats the request may use, such as the one a pin or a thread binds it to.
 */
export function getSoonestQuotaReset(
	meta: RequestMeta,
	ctx: ResolvedPoolContext,
	seatsFor: (fleet: Account[]) => Account[] = (fleet) => fleet,
	callerId?: string,
): number | null {
	const fleet = fleetAccounts(ctx.providerName, ctx);
	return soonestServableAt(
		ctx.provider,
		fleet,
		seatsFor(fleet),
		meta.model,
		ctx,
		Date.now(),
		callerId,
	);
}

/**
 * True when no seat of the fleet has quota left. A seat cooling after a
 * per-minute 429 still has quota, and a list a thread or pin emptied is not
 * the fleet.
 */
export function isEveryAccountQuotaBlocked(
	meta: RequestMeta,
	ctx: ResolvedPoolContext,
	now: number = Date.now(),
	callerId?: string,
): boolean {
	return !fleetAccounts(ctx.providerName, ctx).some((account) =>
		isQuotaEligible(
			ctx.provider,
			account,
			ctx.runtime.quotaThreshold,
			now,
			meta.model,
			ctx,
			callerId,
		),
	);
}

function selectRevalidationProbe(
	accounts: Account[],
	ctx: ResolvedPoolContext,
	now: number,
	model: string | undefined,
	callerId?: string,
): Account[] {
	const probes = ctx.quotaProbeAt;
	const lastProbeAt = probes?.get(ctx.providerName);
	if (
		lastProbeAt !== undefined &&
		now - lastProbeAt < QUOTA_PROBE_INTERVAL_MS
	) {
		return [];
	}

	const [probe] = accounts
		.filter((account) => {
			// A real-client probe remains available for ordinary accounts. It must
			// never bypass a weekly ceiling that applies to a pooled account.
			const routing = ctx.runtime.teamRouting;
			return (
				routing?.enabled !== true ||
				!isAllowlisted(account, routing) ||
				isQuotaEligible(
					ctx.provider,
					account,
					ctx.runtime.quotaThreshold,
					now,
					model,
					ctx,
					callerId,
				)
			);
		})
		.sort(
			(left, right) =>
				soonestWeeklyReset(ctx.provider, left, now) -
				soonestWeeklyReset(ctx.provider, right, now),
		);
	if (!probe) return [];

	probes?.set(ctx.providerName, now);
	return [probe];
}

/**
 * Gets accounts ordered by the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of ordered accounts
 */
export function getOrderedAccounts(
	meta: RequestMeta,
	ctx: ResolvedPoolContext,
	teamRequest?: TeamRoutingRequest,
	options: AccountSelectionOptions = {},
): Account[] {
	const now = Date.now();
	const callerId = teamRequest?.callerId;
	const providerAccounts = ctx.dbOps
		.getAvailableAccountsByProvider(ctx.providerName)
		.filter((account) => refreshBackoffUntil(account, now) === null);
	const eligible = providerAccounts.filter((account) =>
		isQuotaEligible(
			ctx.provider,
			account,
			ctx.runtime.quotaThreshold,
			now,
			meta.model,
			ctx,
			callerId,
		),
	);
	const candidates =
		eligible.length > 0
			? eligible
			: options.allowRevalidationProbe === false || ctx.runtime.blockWhenAllFull
				? []
				: selectRevalidationProbe(
						providerAccounts,
						ctx,
						now,
						meta.model,
						callerId,
					);
	const prioritized = [...candidates].sort((left, right) => {
		const priority = (left.priority ?? 0) - (right.priority ?? 0);
		return priority !== 0
			? priority
			: soonestWeeklyReset(ctx.provider, left, now) -
					soonestWeeklyReset(ctx.provider, right, now);
	});
	const ordered = ctx.strategy.select(prioritized, meta);
	return (
		(options.applyTeamRouting === false
			? undefined
			: ctx.teamRouter?.order(
					ordered,
					teamRequest,
					ctx.runtime.teamRouting,
					ctx.provider,
					ctx.dbOps,
				)) ?? ordered
	);
}

/**
 * Selects accounts for a request based on the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of selected accounts
 */
export function selectAccountsForRequest(
	meta: RequestMeta,
	ctx: ResolvedPoolContext,
	teamRequest?: TeamRoutingRequest,
	options?: AccountSelectionOptions,
): Account[] {
	return getOrderedAccounts(meta, ctx, teamRequest, options);
}
