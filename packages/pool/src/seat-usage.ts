import type { Provider } from "@agent-smith/providers";
import {
	type Account,
	isCurrentQuotaWindow,
	isOpenQuotaWindow,
	type QuotaWindow,
} from "@agent-smith/types";

type SeatUsage = {
	fiveHour: number;
	weekly: number;
};

type BucketWindows = Array<[string, QuotaWindow]>;

/** Only fresh, usable quota close to renewal earns preference; never lent credit. */
function expiringReset(
	provider: Provider,
	account: Account,
	model: string | undefined,
	now: number,
): number {
	const buckets = provider.quotaBucketsFor(model);
	const resets = Object.entries(account.quota_state?.windows ?? {}).flatMap(
		([bucket, window]) => {
			const horizon = provider.isFiveHourBucket(bucket)
				? 60 * 60_000
				: provider.isWeeklyBucket(bucket)
					? 24 * 60 * 60_000
					: 0;
			return horizon > 0 &&
				(buckets?.includes(bucket) ?? true) &&
				window.resetAt !== null &&
				window.resetAt > now &&
				window.resetAt - now <= horizon &&
				window.seenAt <= now &&
				isCurrentQuotaWindow(window, now) &&
				window.status !== "rejected" &&
				window.utilization !== null &&
				window.utilization >= 0 &&
				window.utilization < 1
				? [window.resetAt]
				: [];
		},
	);
	return Math.min(...resets, Number.POSITIVE_INFINITY);
}

/** A reading taken earlier in a window that has not reset is a lower bound, so it still counts. */
function liveUtilization(window: QuotaWindow, now: number): number {
	if (window.utilization === null) return 0;
	return isOpenQuotaWindow(window, now) ? window.utilization : 0;
}

function highestUtilization(windows: BucketWindows, now: number): number {
	return Math.max(
		0,
		...windows.map(([, window]) => liveUtilization(window, now)),
	);
}

function seatUsage(
	provider: Provider,
	account: Account,
	model: string | undefined,
	now: number,
): SeatUsage {
	const buckets = provider.quotaBucketsFor(model);
	const windows = Object.entries(account.quota_state?.windows ?? {}).filter(
		([bucket]) => buckets?.includes(bucket) ?? true,
	);
	const weekly = windows.filter(([bucket]) => provider.isWeeklyBucket(bucket));
	const fiveHour = windows.filter(([bucket]) =>
		provider.isFiveHourBucket(bucket),
	);
	return {
		fiveHour: highestUtilization(fiveHour, now),
		weekly: highestUtilization(weekly, now),
	};
}

export function soonestWeeklyReset(
	provider: Provider,
	account: Account,
	now: number,
): number {
	const resets = Object.entries(account.quota_state?.windows ?? {})
		.filter(
			([bucket, window]) =>
				provider.isWeeklyBucket(bucket) &&
				window.resetAt !== null &&
				window.resetAt > now,
		)
		.map(([, window]) => window.resetAt as number);
	return Math.min(...resets, Number.POSITIVE_INFINITY);
}

/**
 * Orders already-eligible seats for a new conversation by lowest five-hour
 * usage, then lowest weekly usage, then soonest weekly reset. See
 * docs/load-balancing.md.
 */
export function compareSeatUsage(
	provider: Provider,
	model: string | undefined,
	now: number,
	preferExpiringQuota = false,
): (left: Account, right: Account) => number {
	return (left, right) => {
		const a = seatUsage(provider, left, model, now);
		const b = seatUsage(provider, right, model, now);
		return (
			(preferExpiringQuota
				? expiringReset(provider, left, model, now) -
					expiringReset(provider, right, model, now)
				: 0) ||
			a.fiveHour - b.fiveHour ||
			a.weekly - b.weekly ||
			soonestWeeklyReset(provider, left, now) -
				soonestWeeklyReset(provider, right, now)
		);
	};
}
