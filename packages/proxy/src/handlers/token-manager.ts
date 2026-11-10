import { TokenRefreshError } from "@agent-smith/core";
import { Logger } from "@agent-smith/logger";
import type { TokenRefreshResult } from "@agent-smith/providers";
import type { Account } from "@agent-smith/types";
import { TOKEN_REFRESH_BACKOFF_MS, TOKEN_SAFETY_WINDOW_MS } from "../constants";
import { ERROR_MESSAGES, type ResolvedProxyContext } from "./proxy-types";

const log = new Logger("TokenManager");

// Track refresh failures for backoff
const refreshFailures = new Map<
	string,
	{ at: number; error: TokenRefreshError }
>();

export function refreshBackoffUntil(
	accountId: string,
	now: number = Date.now(),
): number | null {
	const failure = refreshFailures.get(accountId);
	return failure && now - failure.at < TOKEN_REFRESH_BACKOFF_MS
		? failure.at + TOKEN_REFRESH_BACKOFF_MS
		: null;
}

export function quarantineAccount(
	account: Account,
	ctx: ResolvedProxyContext,
	reason: string,
): void {
	account.paused = true;
	account.error_reason = reason;
	ctx.asyncWriter.enqueue(() => ctx.dbOps.markAccountError(account.id, reason));
}

function recordRefreshFailure(
	account: Account,
	ctx: ResolvedProxyContext,
	error: unknown,
): TokenRefreshError {
	const refreshError = new TokenRefreshError(account.id, error as Error);
	refreshFailures.set(account.id, { at: Date.now(), error: refreshError });
	const status = (error as { status?: unknown } | null)?.status;
	if (
		typeof status === "number" &&
		status >= 400 &&
		status < 500 &&
		status !== 408 &&
		status !== 429
	) {
		quarantineAccount(
			account,
			ctx,
			"OAuth refresh was rejected by the upstream",
		);
	}
	log.error(`Token refresh failed for account ${account.name}`, error);
	return refreshError;
}

/**
 * Safely refreshes an access token with deduplication
 * @param account - The account to refresh token for
 * @param ctx - The proxy context
 * @returns Promise resolving to the new access token
 * @throws {TokenRefreshError} If token refresh fails
 */
export async function refreshAccessTokenSafe(
	account: Account,
	ctx: ResolvedProxyContext,
): Promise<string> {
	// Check for recent refresh failures and implement backoff
	const lastFailure = refreshFailures.get(account.id);
	if (lastFailure && refreshBackoffUntil(account.id) !== null) {
		log.warn(`Account ${account.name} is in refresh backoff period`);
		throw lastFailure.error;
	}

	// Check if a refresh is already in progress for this account
	if (!ctx.refreshInFlight.has(account.id)) {
		if (!ctx.provider.refreshToken) {
			throw new TokenRefreshError(
				account.id,
				new Error(
					`Provider ${ctx.provider.name} does not support OAuth token refresh`,
				),
			);
		}

		// Create a new refresh promise and store it
		const refreshPromise = ctx.provider
			.refreshToken(account, ctx.runtime.clientId)
			.then((result: TokenRefreshResult) => {
				// 1. Persist to database asynchronously
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.updateAccountTokens(
						account.id,
						result.accessToken,
						result.expiresAt,
						result.refreshToken,
					),
				);

				// 2. Update the live in-memory account object immediately
				// This prevents subsequent requests from seeing stale token data
				account.access_token = result.accessToken;
				account.expires_at = result.expiresAt;
				if (result.refreshToken) {
					account.refresh_token = result.refreshToken;
				}
				account.last_used = Date.now();

				// Clear any previous failure record on successful refresh
				refreshFailures.delete(account.id);

				log.info(`Successfully refreshed token for account: ${account.name}`);
				return result.accessToken;
			})
			.catch((error) => {
				throw recordRefreshFailure(account, ctx, error);
			})
			.finally(() => {
				// Clean up the map when done (success or failure)
				ctx.refreshInFlight.delete(account.id);
			});
		ctx.refreshInFlight.set(account.id, refreshPromise);
	}

	// Return the existing or new refresh promise
	const promise = ctx.refreshInFlight.get(account.id);
	if (!promise) {
		throw new TokenRefreshError(
			account.id,
			new Error(ERROR_MESSAGES.REFRESH_NOT_FOUND),
		);
	}
	return promise;
}

/**
 * Gets a valid access token for an account, refreshing if necessary
 * @param account - The account to get token for
 * @param ctx - The proxy context
 * @returns Promise resolving to a valid access token
 */
export async function getValidAccessToken(
	account: Account,
	ctx: ResolvedProxyContext,
): Promise<string> {
	// API key accounts don't use access tokens
	if (!account.refresh_token && account.api_key) {
		// Return empty string - the API key will be used in prepareHeaders
		return "";
	}

	// Check if token exists and won't expire within the safety window
	if (
		account.access_token &&
		account.expires_at &&
		account.expires_at - Date.now() > TOKEN_SAFETY_WINDOW_MS
	) {
		return account.access_token;
	}

	// Token is expired, missing, or will expire soon
	const reason = !account.access_token
		? "missing"
		: !account.expires_at
			? "no expiry"
			: account.expires_at <= Date.now()
				? "expired"
				: "expiring soon";

	log.info(`Token ${reason} for account: ${account.name}`);
	return await refreshAccessTokenSafe(account, ctx);
}
