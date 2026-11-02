import type { TeamRoutingConfig, TeamRoutingFileConfig } from "@ccflare/config";
import type { Account, AccountQuotaState } from "@ccflare/types";

export type LocalPoolState = "pooled" | "protected" | "unavailable";

export function isPoolEligible(account: Account): boolean {
	return (
		account.auth_method === "oauth" &&
		typeof account.account_uuid === "string" &&
		account.account_uuid.length > 0
	);
}

export function localPoolState(
	account: Account,
	routing: TeamRoutingConfig,
): LocalPoolState {
	if (!isPoolEligible(account)) return "unavailable";

	return routing.enabled &&
		routing.allowlistedAccountUuids.includes(account.account_uuid as string)
		? "pooled"
		: "protected";
}

export function nextTeamRoutingConfig(
	routing: TeamRoutingConfig,
	account: Account,
	pooled: boolean,
): TeamRoutingConfig {
	if (!isPoolEligible(account)) {
		throw new Error(
			"Only an OAuth seat with a verified account identity can join the local pool.",
		);
	}

	const accountUuid = account.account_uuid as string;
	const existing = routing.allowlistedAccountUuids.filter(
		(uuid) => uuid !== accountUuid,
	);
	const allowlistedAccountUuids = pooled
		? [...existing, accountUuid]
		: existing;

	return {
		...routing,
		enabled: allowlistedAccountUuids.length > 0,
		allowlistedAccountUuids,
	};
}

export function teamRoutingFileConfig(
	routing: TeamRoutingConfig,
): TeamRoutingFileConfig {
	return {
		enabled: routing.enabled,
		distribution_enabled: routing.distributionEnabled,
		allowlisted_account_uuids: routing.allowlistedAccountUuids,
		max_usage: routing.maxUsage,
		admission_cap: routing.admissionCap,
		admission_queue_limit: routing.admissionQueueLimit,
		admission_wait_ms: routing.admissionWaitMs,
		hold_seconds: routing.holdSeconds,
		quota_probe_seconds: routing.quotaProbeSeconds,
	};
}

function quotaWindowLabel(key: string): string {
	const standard = {
		unified5h: "5h",
		unified7d: "7d",
	} as const;
	if (key in standard) return standard[key as keyof typeof standard];

	return key.replace(/^unified/, "") || key;
}

export function formatPoolLimits(quotaState: AccountQuotaState | null): string {
	const windows = Object.entries(quotaState?.windows ?? {})
		.filter(([, window]) => typeof window.utilization === "number")
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, window]) => {
			const percent = Math.round((window.utilization as number) * 100);
			return `${quotaWindowLabel(name)} ${percent}%`;
		});

	return windows.length > 0 ? windows.join(" · ") : "limits not observed yet";
}
