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
import { soonestWeeklyReset } from "../seat-usage";
import { isAllowlisted, type TeamRoutingRequest } from "../team-router";
import type { ProxyContext, ResolvedProxyContext } from "./proxy-types";
import { refreshBackoffUntil } from "./token-manager";

type EligibilityContext = Pick<ProxyContext, "runtime" | "dbOps">;
type PoolStatusContext = Pick<
	ProxyContext,
	"runtime" | "dbOps" | "providerRegistry"
>;

const QUOTA_PROBE_INTERVAL_MS = 60_000;

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
	maxUsage: number | undefined,
): boolean {
	const threshold = Math.min(
		quotaThresholdFor(account, bucket, fleetThreshold),
		maxUsage ?? Number.POSITIVE_INFINITY,
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
	account: Account,
	ctx: EligibilityContext,
): number | undefined {
	const teamRouting = ctx.runtime.teamRouting;
	return teamRouting?.enabled === true && isAllowlisted(account, teamRouting)
		? teamRouting.maxUsage
		: undefined;
}

function isQuotaEligible(
	provider: Provider,
	account: Account,
	fleetThreshold: number,
	now: number,
	model: string | undefined,
	ctx: EligibilityContext,
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
				pooledMaxUsage(account, ctx),
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
	const teamRouting = ctx.runtime.teamRouting;
	return ctx.dbOps
		.getAccountsByProvider(provider)
		.filter(
			(account) =>
				!account.paused &&
				(teamRouting?.enabled !== true || isAllowlisted(account, teamRouting)),
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
	const refreshEnd = refreshBackoffUntil(account.id, now);
	return rateLimitEnd === null
		? refreshEnd
		: Math.max(rateLimitEnd, refreshEnd ?? 0);
}

function blockingResets(
	provider: Provider,
	account: Account,
	model: string | undefined,
	ctx: EligibilityContext,
	now: number,
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
					pooledMaxUsage(account, ctx),
				),
		)
		.map(([, window]) => window.resetAt as number);
}

/** When this seat serves again: every blocking window reset and its cooldown over. */
function servableAt(
	provider: Provider,
	account: Account,
	model: string | undefined,
	ctx: EligibilityContext,
	now: number,
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
		)
	) {
		return cooldown;
	}
	const resets = blockingResets(provider, account, model, ctx, now);
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
): number | null {
	if (
		!fleet.some(
			(account) =>
				blockingResets(provider, account, model, ctx, now).length > 0,
		)
	) {
		return null;
	}
	const times = seats.flatMap((account) => {
		const at = servableAt(provider, account, model, ctx, now);
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
	const eligibleAccounts = accounts.filter(
		(account) =>
			cooldownEnd(account, now) === null &&
			isQuotaEligible(
				providerStrategy,
				account,
				ctx.runtime.quotaThreshold,
				now,
				model,
				ctx,
			),
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

/**
 * When a request refused for quota may retry. `seatsFor` narrows the fleet to
 * the seats the request may use, such as the one a pin or a thread binds it to.
 */
export function getSoonestQuotaReset(
	meta: RequestMeta,
	ctx: ResolvedProxyContext,
	seatsFor: (fleet: Account[]) => Account[] = (fleet) => fleet,
): number | null {
	const fleet = fleetAccounts(ctx.providerName, ctx);
	return soonestServableAt(
		ctx.provider,
		fleet,
		seatsFor(fleet),
		meta.model,
		ctx,
		Date.now(),
	);
}

/**
 * True when no seat of the fleet has quota left. A seat cooling after a
 * per-minute 429 still has quota, and a list a thread or pin emptied is not
 * the fleet.
 */
export function isEveryAccountQuotaBlocked(
	meta: RequestMeta,
	ctx: ResolvedProxyContext,
	now: number = Date.now(),
): boolean {
	return !fleetAccounts(ctx.providerName, ctx).some((account) =>
		isQuotaEligible(
			ctx.provider,
			account,
			ctx.runtime.quotaThreshold,
			now,
			meta.model,
			ctx,
		),
	);
}

function selectRevalidationProbe(
	accounts: Account[],
	ctx: ResolvedProxyContext,
	now: number,
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
			// W2's real-client revalidation remains available for ordinary
			// accounts. A pooled seat's 90% owner reserve is stricter: it is
			// never consumed by a probe.
			return (
				pooledMaxUsage(account, ctx) === undefined ||
				isQuotaEligible(
					ctx.provider,
					account,
					ctx.runtime.quotaThreshold,
					now,
					undefined,
					ctx,
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
	ctx: ResolvedProxyContext,
	teamRequest?: TeamRoutingRequest,
	options: AccountSelectionOptions = {},
): Account[] {
	const now = Date.now();
	const providerAccounts = ctx.dbOps
		.getAvailableAccountsByProvider(ctx.providerName)
		.filter((account) => refreshBackoffUntil(account.id, now) === null);
	const eligible = providerAccounts.filter((account) =>
		isQuotaEligible(
			ctx.provider,
			account,
			ctx.runtime.quotaThreshold,
			now,
			meta.model,
			ctx,
		),
	);
	const candidates =
		eligible.length > 0
			? eligible
			: options.allowRevalidationProbe === false || ctx.runtime.blockWhenAllFull
				? []
				: selectRevalidationProbe(providerAccounts, ctx, now);
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
	ctx: ResolvedProxyContext,
	teamRequest?: TeamRoutingRequest,
	options?: AccountSelectionOptions,
): Account[] {
	return getOrderedAccounts(meta, ctx, teamRequest, options);
}
