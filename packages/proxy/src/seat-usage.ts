import type { Provider } from "@ccflare/providers";
import {
	type Account,
	isCurrentQuotaWindow,
	type QuotaWindow,
} from "@ccflare/types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

type SeatUsage = {
	aheadOfWeeklyPace: boolean;
	fiveHour: number;
	weekly: number;
};

type BucketWindows = Array<[string, QuotaWindow]>;

/** A reading taken earlier in a window that has not reset is a lower bound, so it still counts. */
function liveUtilization(window: QuotaWindow, now: number): number {
	if (window.utilization === null) return 0;
	const windowOpen =
		window.resetAt === null
			? isCurrentQuotaWindow(window, now)
			: window.resetAt > now;
	return windowOpen ? window.utilization : 0;
}

function isAheadOfWeeklyPace(window: QuotaWindow, now: number): boolean {
	if (window.resetAt === null || window.resetAt <= now) return false;
	const elapsedShareOfWeek = 1 - (window.resetAt - now) / WEEK_MS;
	return liveUtilization(window, now) > elapsedShareOfWeek;
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
		aheadOfWeeklyPace: weekly.some(([, window]) =>
			isAheadOfWeeklyPace(window, now),
		),
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
 * Orders seats for a new conversation: a seat on its weekly pace before one
 * ahead of it, then the lowest five-hour usage, then the lowest weekly usage,
 * then the soonest weekly reset. See docs/load-balancing.md.
 */
export function compareSeatUsage(
	provider: Provider,
	model: string | undefined,
	now: number,
): (left: Account, right: Account) => number {
	return (left, right) => {
		const a = seatUsage(provider, left, model, now);
		const b = seatUsage(provider, right, model, now);
		return (
			Number(a.aheadOfWeeklyPace) - Number(b.aheadOfWeeklyPace) ||
			a.fiveHour - b.fiveHour ||
			a.weekly - b.weekly ||
			soonestWeeklyReset(provider, left, now) -
				soonestWeeklyReset(provider, right, now)
		);
	};
}
