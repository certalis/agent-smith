import type { Provider } from "@agent-smith/providers";
import type {
	Account,
	AccountQuotaState,
	OutsideSpend,
} from "@agent-smith/types";

const RESET_DROP_EPSILON = 0.05;
const SETTLE_MS = 5_000;

type Reading = {
	activityVersion: number;
	resetAt: number | null;
	utilization: number;
};

type Activity = {
	active: number;
	lastEndedAt: number | null;
	version: number;
};

/**
 * Attributes a rise between two quota readings only when the proxy was idle.
 * It is intentionally conservative: any ambiguous interval becomes
 * not_measurable, never a made-up zero percent.
 */
export class OutsideSpendTracker {
	private readonly activity = new Map<string, Activity>();
	private readonly readings = new Map<string, Map<string, Reading>>();

	constructor(private readonly now: () => number = Date.now) {}

	begin(accountId: string): void {
		const activity = this.forAccount(accountId);
		activity.active += 1;
		activity.version += 1;
	}

	end(accountId: string): void {
		const activity = this.forAccount(accountId);
		activity.active = Math.max(0, activity.active - 1);
		activity.lastEndedAt = this.now();
	}

	observe(
		account: Account,
		observed: AccountQuotaState,
		provider: Provider,
	): AccountQuotaState {
		const previous = account.quota_state;
		const merged: AccountQuotaState = {
			...previous,
			...observed,
			windows: { ...previous?.windows, ...observed.windows },
		};
		const outsideSpend = { ...previous?.outsideSpend };
		for (const [bucket, window] of Object.entries(observed.windows)) {
			if (!provider.isWeeklyBucket(bucket) || window.utilization === null)
				continue;
			outsideSpend[bucket] = this.observeWindow(
				account.id,
				bucket,
				window.utilization,
				window.resetAt,
				outsideSpend[bucket],
			);
		}
		return { ...merged, outsideSpend };
	}

	private observeWindow(
		accountId: string,
		bucket: string,
		utilization: number,
		resetAt: number | null,
		previousView: OutsideSpend | undefined,
	): OutsideSpend {
		const now = this.now();
		const activity = this.forAccount(accountId);
		const byBucket = this.readings.get(accountId) ?? new Map<string, Reading>();
		this.readings.set(accountId, byBucket);
		const prior = byBucket.get(bucket);
		const unsettled =
			activity.active > 0 ||
			(activity.lastEndedAt !== null && now - activity.lastEndedAt < SETTLE_MS);
		const changedWindow =
			prior &&
			((resetAt !== null &&
				prior.resetAt !== null &&
				resetAt > prior.resetAt) ||
				utilization < prior.utilization - RESET_DROP_EPSILON);
		if (!prior || changedWindow) {
			byBucket.set(bucket, {
				activityVersion: activity.version,
				resetAt,
				utilization,
			});
			return { share: null, state: "not_observed", since: now };
		}

		const attributable =
			!unsettled && prior.activityVersion === activity.version;
		const rise = Math.max(0, utilization - prior.utilization);
		byBucket.set(bucket, {
			activityVersion: activity.version,
			resetAt,
			utilization,
		});
		if (!attributable) {
			return {
				share: null,
				state: "not_measurable",
				since: previousView?.since ?? now,
			};
		}
		return {
			share: Math.max(0, (previousView?.share ?? 0) + rise),
			state: "measured",
			since: previousView?.since ?? now,
		};
	}

	private forAccount(accountId: string): Activity {
		const existing = this.activity.get(accountId);
		if (existing) return existing;
		const activity = { active: 0, lastEndedAt: null, version: 0 };
		this.activity.set(accountId, activity);
		return activity;
	}
}
