import type { ProviderRegistry } from "@agent-smith/providers";
import {
	type Account,
	getAccountRateLimitInfo,
	getAccountSessionInfo,
	getAccountTokenStatus,
} from "@agent-smith/types";
import type { AccountResponse } from "../types";

export function serializeAccount(
	account: Account,
	providerRegistry: ProviderRegistry,
	now: number = Date.now(),
): AccountResponse {
	const rateLimit = getAccountRateLimitInfo(account, now);
	const session = getAccountSessionInfo(account);

	return {
		id: account.id,
		name: account.name,
		provider: account.provider,
		providerDisabled: !providerRegistry.getProvider(account.provider),
		auth_method: account.auth_method,
		base_url: account.base_url,
		requestCount: account.request_count,
		totalRequests: account.total_requests,
		lastUsed: account.last_used
			? new Date(account.last_used).toISOString()
			: null,
		created: new Date(account.created_at).toISOString(),
		weight: account.weight,
		priority: account.priority ?? 0,
		switchThreshold: account.switch_threshold ?? null,
		errorReason: account.error_reason ?? null,
		paused: account.paused,
		tokenStatus: getAccountTokenStatus(account, now),
		tokenExpiresAt: account.expires_at
			? new Date(account.expires_at).toISOString()
			: null,
		rateLimitStatus: {
			code: rateLimit.code,
			isLimited: rateLimit.isLimited,
			until: rateLimit.until ? new Date(rateLimit.until).toISOString() : null,
		},
		rateLimitReset: rateLimit.resetAt
			? new Date(rateLimit.resetAt).toISOString()
			: null,
		rateLimitRemaining: rateLimit.remaining,
		sessionInfo: {
			active: session.active,
			startedAt: session.startedAt
				? new Date(session.startedAt).toISOString()
				: null,
			requestCount: session.requestCount,
		},
	};
}
