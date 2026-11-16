import {
	type Account,
	type AccountQuotaState,
	isRecord,
	type ResetCredit,
	type ResetCreditRequest,
	type ResetCreditResult,
	type ResetCredits,
} from "@agent-smith/types";

const BACKEND = "https://chatgpt.com/backend-api/wham";
const INVALID = "Invalid Codex reset response";

function string(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 2_000;
}

function date(value: unknown): value is string {
	return string(value) && Number.isFinite(Date.parse(value));
}

function nullableText(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.length > 4_000)
		throw new Error(INVALID);
	return value;
}

function nonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function credit(value: unknown): ResetCredit {
	if (
		!isRecord(value) ||
		!string(value.id) ||
		!string(value.reset_type) ||
		!string(value.status) ||
		!date(value.granted_at) ||
		(value.expires_at !== null && !date(value.expires_at))
	)
		throw new Error(INVALID);
	return {
		id: value.id,
		resetType: value.reset_type,
		status: value.status,
		grantedAt: value.granted_at,
		expiresAt: value.expires_at,
		title: nullableText(value.title),
		description: nullableText(value.description),
	};
}

async function request(
	account: Account,
	token: string,
	path: string,
	body?: unknown,
): Promise<unknown> {
	// Never honor an account-supplied URL or a redirect with a subscription token.
	const response = await fetch(`${BACKEND}/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"chatgpt-account-id": account.account_uuid ?? "",
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Codex reset request failed (${response.status})`);
	}
	try {
		return await response.json();
	} catch {
		throw new Error(INVALID);
	}
}

export async function listCodexResetCredits(
	account: Account,
	token: string,
): Promise<ResetCredits> {
	const payload = await request(account, token, "rate-limit-reset-credits");
	if (
		!isRecord(payload) ||
		!nonnegativeInteger(payload.available_count) ||
		!Array.isArray(payload.credits) ||
		payload.credits.length > 1_000
	)
		throw new Error(INVALID);
	return {
		availableCount: payload.available_count,
		credits: payload.credits.map(credit),
	};
}

export async function consumeCodexResetCredit(
	account: Account,
	token: string,
	attempt: ResetCreditRequest,
): Promise<ResetCreditResult> {
	const payload = await request(
		account,
		token,
		"rate-limit-reset-credits/consume",
		{
			credit_id: attempt.creditId,
			redeem_request_id: attempt.requestId,
		},
	);
	if (
		!isRecord(payload) ||
		!["reset", "nothing_to_reset", "no_credit", "already_redeemed"].includes(
			String(payload.code),
		) ||
		!nonnegativeInteger(payload.windows_reset ?? 0)
	)
		throw new Error(INVALID);
	return {
		code: payload.code as ResetCreditResult["code"],
		windowsReset: (payload.windows_reset ?? 0) as number,
	};
}

/** A reset is not evidence of zero usage. Read only the provider's actual windows. */
export async function readCodexResetQuota(
	account: Account,
	token: string,
): Promise<AccountQuotaState | null> {
	const payload = await request(account, token, "usage");
	if (!isRecord(payload) || !isRecord(payload.rate_limit)) return null;
	const windows: AccountQuotaState["windows"] = {};
	for (const value of [
		payload.rate_limit.primary_window,
		payload.rate_limit.secondary_window,
	]) {
		if (!isRecord(value)) continue;
		const bucket =
			value.limit_window_seconds === 18_000
				? "unified5h"
				: value.limit_window_seconds === 604_800
					? "unified7d"
					: null;
		if (
			!bucket ||
			typeof value.used_percent !== "number" ||
			!Number.isFinite(value.used_percent) ||
			value.used_percent < 0 ||
			value.used_percent > 100 ||
			typeof value.reset_at !== "number" ||
			!Number.isSafeInteger(value.reset_at) ||
			value.reset_at * 1_000 <= Date.now()
		)
			continue;
		windows[bucket] = {
			utilization: value.used_percent / 100,
			resetAt: value.reset_at * 1_000,
			seenAt: Date.now(),
			// The aggregate limit may refer to the other window. Eligibility uses each percentage.
			status: null,
		};
	}
	return Object.keys(windows).length > 0 ? { windows } : null;
}
