import type { Provider } from "@ccflare/providers";
import {
	type Account,
	type AccountProvider,
	isCurrentQuotaWindow,
	type PoolStatus,
	quotaThresholdFor,
	type RequestMeta,
} from "@ccflare/types";
import { soonestWeeklyReset } from "../seat-usage";
import { isAllowlisted, type TeamRoutingRequest } from "../team-router";
import type { ProxyContext, ResolvedProxyContext } from "./proxy-types";

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
		isCurrentQuotaWindow(window, now) &&
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
	const accounts = config?.enabled
		? ctx.dbOps
				.getAvailableAccountsByProvider(provider)
				.filter((account) => isAllowlisted(account, config))
		: [];
	const eligibleAccounts = accounts.filter((account) =>
		isQuotaEligible(
			providerStrategy,
			account,
			ctx.runtime.quotaThreshold,
			now,
			model,
			ctx,
		),
	).length;
	const resets = accounts.flatMap((account) =>
		Object.entries(account.quota_state?.windows ?? {})
			.filter(
				([bucket, window]) =>
					window.resetAt !== null &&
					window.resetAt > now &&
					isQuotaBlocking(
						providerStrategy,
						account,
						bucket,
						window,
						ctx.runtime.quotaThreshold,
						now,
						model,
						pooledMaxUsage(account, ctx),
					),
			)
			.map(([, window]) => window.resetAt as number),
	);
	return {
		version: 1,
		provider,
		routingEnabled: config?.enabled === true,
		eligibleAccounts,
		retryAtMs:
			eligibleAccounts === 0 && resets.length > 0 ? Math.min(...resets) : null,
		holdSeconds: config?.holdSeconds ?? 0,
		admissionWaitMs: config?.admissionWaitMs ?? 0,
	};
}

/** Returns the next known reset among quota windows relevant to this request. */
export function getSoonestQuotaReset(
	meta: RequestMeta,
	ctx: ResolvedProxyContext,
	now: number = Date.now(),
): number | null {
	const resets = ctx.dbOps
		.getAvailableAccountsByProvider(ctx.providerName)
		.flatMap((account) =>
			Object.entries(account.quota_state?.windows ?? {}).map(
				([bucket, window]) => ({ account, bucket, window }),
			),
		)
		.filter(
			({ account, bucket, window }) =>
				window.resetAt !== null &&
				window.resetAt > now &&
				isQuotaBlocking(
					ctx.provider,
					account,
					bucket,
					window,
					ctx.runtime.quotaThreshold,
					now,
					meta.model,
					pooledMaxUsage(account, ctx),
				),
		)
		.map(({ window }) => window.resetAt as number);
	return resets.length > 0 ? Math.min(...resets) : null;
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
	const providerAccounts = ctx.dbOps.getAvailableAccountsByProvider(
		ctx.providerName,
	);
	const now = Date.now();
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
			: options.allowRevalidationProbe === false
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
