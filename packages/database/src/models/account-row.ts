import type {
	Account,
	AccountProvider,
	AccountQuotaState,
	AccountSwitchThreshold,
	AuthMethod,
} from "@agent-smith/types";

export interface AccountRow {
	id: string;
	name: string;
	provider: AccountProvider;
	auth_method: AuthMethod;
	base_url: string | null;
	api_key: string | null;
	refresh_token: string | null;
	access_token: string | null;
	expires_at: number | null;
	created_at: number;
	last_used: number | null;
	request_count: number;
	total_requests: number;
	rate_limited_until?: number | null;
	session_start?: number | null;
	session_request_count?: number;
	weight: number;
	priority?: number;
	switch_threshold?: string | null;
	error_reason?: string | null;
	paused?: 0 | 1;
	rate_limit_reset?: number | null;
	rate_limit_status?: string | null;
	rate_limit_remaining?: number | null;
	account_uuid?: string | null;
	organization_uuid?: string | null;
	quota_state?: string | null;
}

function parseQuotaState(
	value: string | null | undefined,
): AccountQuotaState | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed) &&
			typeof (parsed as Record<string, unknown>).windows === "object"
		) {
			return parsed as AccountQuotaState;
		}
	} catch {
		// A malformed persisted observation is ignored rather than blocking routing.
	}
	return null;
}

function parseSwitchThreshold(
	value: string | null | undefined,
): AccountSwitchThreshold | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (typeof parsed === "number") {
			return Number.isFinite(parsed) && parsed > 0 && parsed <= 1
				? parsed
				: null;
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return null;
		}

		const entries = Object.entries(parsed).filter(
			([, entry]) =>
				typeof entry === "number" &&
				Number.isFinite(entry) &&
				entry > 0 &&
				entry <= 1,
		);
		return entries.length > 0 ? Object.fromEntries(entries) : null;
	} catch {
		return null;
	}
}

export function toAccount(row: AccountRow): Account {
	return {
		id: row.id,
		name: row.name,
		provider: row.provider,
		auth_method: row.auth_method,
		base_url: row.base_url,
		api_key: row.api_key,
		refresh_token: row.refresh_token,
		access_token: row.access_token,
		expires_at: row.expires_at,
		created_at: row.created_at,
		last_used: row.last_used,
		request_count: row.request_count,
		total_requests: row.total_requests,
		rate_limited_until: row.rate_limited_until ?? null,
		session_start: row.session_start ?? null,
		session_request_count: row.session_request_count ?? 0,
		weight: row.weight || 1,
		priority: row.priority ?? 0,
		switch_threshold: parseSwitchThreshold(row.switch_threshold),
		error_reason: row.error_reason ?? null,
		paused: row.paused === 1,
		rate_limit_reset: row.rate_limit_reset ?? null,
		rate_limit_status: row.rate_limit_status ?? null,
		rate_limit_remaining: row.rate_limit_remaining ?? null,
		account_uuid: row.account_uuid ?? null,
		organization_uuid: row.organization_uuid ?? null,
		quota_state: parseQuotaState(row.quota_state),
	};
}
