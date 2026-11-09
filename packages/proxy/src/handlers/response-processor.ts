import { logError, RateLimitError } from "@agent-smith/core";
import { Logger } from "@agent-smith/logger";
import type { Provider, RateLimitInfo } from "@agent-smith/providers";
import type { Account } from "@agent-smith/types";
import type { ResolvedProxyContext } from "./proxy-types";

const log = new Logger("ResponseProcessor");

export const MAX_INLINE_RATE_LIMIT_RETRY_MS = 60_000;

function retryAfterMs(response: Response): number | undefined {
	const value = response.headers.get("retry-after");
	if (!value) return undefined;

	const seconds = Number(value);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds) * 1000;
	}

	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export async function isQuotaRejection(
	response: Response,
	provider: Provider,
): Promise<boolean> {
	return (await provider.isQuotaRejection?.(response)) ?? false;
}

function isOrganizationDeniedPayload(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const payload = value as Record<string, unknown>;
	const error =
		typeof payload.error === "object" &&
		payload.error !== null &&
		!Array.isArray(payload.error)
			? (payload.error as Record<string, unknown>)
			: undefined;
	return (
		payload.type === "oauth_not_allowed_for_organization" ||
		payload.code === "oauth_not_allowed_for_organization" ||
		error?.type === "oauth_not_allowed_for_organization" ||
		error?.code === "oauth_not_allowed_for_organization"
	);
}

export async function isOrganizationForbidden(
	response: Response,
): Promise<boolean> {
	if (response.status !== 403) return false;
	try {
		return isOrganizationDeniedPayload(await response.clone().json());
	} catch {
		return false;
	}
}

/**
 * A bare 429 belongs to the request, not to the account. Provider quota and
 * per-minute responses always carry a rate-limit signal that lets us make an
 * account-level decision.
 */
export function isRequestScopedRateLimit(
	response: Response,
	provider: Provider,
): boolean {
	return (
		response.status === 429 &&
		![...response.headers.keys()].some((name) =>
			provider.hasRateLimitSignal?.(name),
		)
	);
}

/** A 429 with Retry-After is a temporary per-minute limit, unless quota says
 * the account is rejected. */
export function getPerMinuteRetryAfterMs(
	response: Response,
	quotaRejected: boolean = false,
): number | undefined {
	if (response.status !== 429 || quotaRejected) {
		return undefined;
	}

	return retryAfterMs(response);
}

/**
 * A provider-side 5xx is safe to retry on one sibling. This deliberately
 * excludes 429: rate limits have their own, stricter classification above.
 */
export function isUpstreamFailureResponse(response: Response): boolean {
	return response.status === 529 || response.status >= 500;
}

/**
 * Handles rate limit response for an account
 * @param account - The rate-limited account
 * @param rateLimitInfo - Parsed rate limit information
 * @param ctx - The proxy context
 */
export function handleRateLimitResponse(
	account: Account,
	rateLimitInfo: RateLimitInfo,
	ctx: ResolvedProxyContext,
): void {
	if (!rateLimitInfo.resetTime) return;

	log.warn(
		`Account ${account.name} rate-limited until ${new Date(
			rateLimitInfo.resetTime,
		).toISOString()}`,
	);

	const resetTime = rateLimitInfo.resetTime;
	ctx.asyncWriter.enqueue(() =>
		ctx.dbOps.markAccountRateLimited(account.id, resetTime),
	);

	const rateLimitError = new RateLimitError(
		account.id,
		rateLimitInfo.resetTime,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
}

/**
 * Updates account rate-limit metadata in the background.
 * Usage counters are owned by the worker after it processes the full response.
 * Accepts pre-parsed rate limit info to avoid re-parsing headers.
 */
export function updateAccountMetadata(
	account: Account,
	rateLimitInfo: RateLimitInfo,
	ctx: ResolvedProxyContext,
): void {
	// Only update rate limit metadata when we have actual rate limit headers
	if (rateLimitInfo.statusHeader) {
		const status = rateLimitInfo.statusHeader;
		ctx.asyncWriter.enqueue(() =>
			ctx.dbOps.updateAccountRateLimitMeta(
				account.id,
				status,
				rateLimitInfo.resetTime ?? null,
				rateLimitInfo.remaining,
			),
		);
	}
	if (rateLimitInfo.quotaState) {
		const quotaState = ctx.outsideSpendTracker
			? ctx.outsideSpendTracker.observe(
					account,
					rateLimitInfo.quotaState,
					ctx.provider,
				)
			: rateLimitInfo.quotaState;
		account.quota_state = quotaState;
		ctx.asyncWriter.enqueue(() =>
			ctx.dbOps.updateAccountQuotaState(account.id, quotaState),
		);
	}
}

/**
 * Processes a successful proxy response
 * @param response - The provider response
 * @param account - The account used
 * @param ctx - The proxy context
 * @returns Whether the response is rate-limited
 */
export function processProxyResponse(
	response: Response,
	account: Account,
	ctx: ResolvedProxyContext,
	quotaRejected: boolean = false,
): boolean {
	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;
	// Parse rate-limit headers once and pass the result through
	const rateLimitInfo = ctx.provider.parseRateLimit(response);

	// Handle rate limit
	if (!isStream && rateLimitInfo.isRateLimited) {
		// Unified quota rejections belong to a quota bucket, not the generic
		// cooldown. Keeping rate_limited_until clear lets model-family selection
		// and the once-per-minute all-spent probe inspect that persisted bucket.
		if (!quotaRejected) {
			handleRateLimitResponse(account, rateLimitInfo, ctx);
		}
		updateAccountMetadata(account, rateLimitInfo, ctx);
		return true; // Signal rate limit
	}

	// Update account metadata in background
	updateAccountMetadata(account, rateLimitInfo, ctx);
	return false;
}

/**
 * Handles errors that occur during proxy operations
 * @param error - The error that occurred
 * @param account - The account that failed (optional)
 * @param logger - Logger instance
 */
export function handleProxyError(
	error: unknown,
	account: Account | null,
	logger: Logger,
): void {
	logError(error, logger);
	if (account) {
		logger.error(`Failed to proxy request with account ${account.name}`);
	} else {
		logger.error("Failed to proxy request");
	}
}
