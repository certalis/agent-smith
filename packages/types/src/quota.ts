import type { Account, QuotaWindow } from "./account";

/** Quota snapshots older than this may not safely exclude an account. */
export const QUOTA_STALE_MS = 30 * 60_000;

export function quotaThresholdFor(
	account: Account,
	bucket: string,
	fleetThreshold: number,
): number {
	const threshold = account.switch_threshold;
	if (typeof threshold === "number") return threshold;
	return threshold?.[bucket] ?? threshold?.default ?? fleetThreshold;
}

export function isCurrentQuotaWindow(
	window: QuotaWindow,
	now: number,
): boolean {
	return (
		(window.resetAt === null || window.resetAt > now) &&
		now - window.seenAt <= QUOTA_STALE_MS
	);
}
