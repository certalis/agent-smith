import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import { jsonResponse } from "@ccflare/http";
import type { ProviderRegistry } from "@ccflare/providers";
import {
	type Account,
	isCurrentQuotaWindow,
	quotaThresholdFor,
} from "@ccflare/types";
import { serializeAccount } from "../serializers/account";

function blockedReason(
	account: Account,
	threshold: number,
	now: number,
): string | null {
	if (account.error_reason) return account.error_reason;
	if (account.paused) return "disabled by operator";
	if (account.rate_limited_until && account.rate_limited_until > now) {
		return `rate limited until ${new Date(account.rate_limited_until).toISOString()}`;
	}

	for (const [bucket, window] of Object.entries(
		account.quota_state?.windows ?? {},
	)) {
		if (!isCurrentQuotaWindow(window, now)) continue;
		if (window.status === "rejected") return `quota ${bucket} rejected`;
		const windowThreshold = quotaThresholdFor(account, bucket, threshold);
		if (window.utilization !== null && window.utilization >= windowThreshold) {
			return `quota ${bucket} reached the ${Math.round(windowThreshold * 100)}% threshold`;
		}
	}

	return null;
}

/** JSON control-plane summary for the pooled fleet, without credentials. */
export function createFleetStatusHandler(
	dbOps: DatabaseOperations,
	config: Config,
	providerRegistry: ProviderRegistry,
) {
	return (): Response => {
		const now = Date.now();
		const quotaThreshold = config.getRuntime().quotaThreshold;
		const accounts = dbOps.getAllAccounts().map((account) => ({
			...serializeAccount(account, providerRegistry, now),
			blockedReason: blockedReason(account, quotaThreshold, now),
			quotaWindows: account.quota_state?.windows ?? {},
			outsideSpend: account.quota_state?.outsideSpend ?? {},
		}));

		return jsonResponse({ accounts, quotaThreshold });
	};
}
