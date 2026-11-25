import { logError, RateLimitError } from "@agent-smith/core";
import { Logger } from "@agent-smith/logger";
import type { RateLimitInfo } from "@agent-smith/providers";
import type { Account } from "@agent-smith/types";
import {
	type MessageThreadRequest,
	rememberMessageThread,
} from "./handlers/message-thread";
import { quarantineAccount } from "./handlers/token-manager";
import type { ResolvedPoolContext } from "./pool-context";

const log = new Logger("ResponseProcessor");

export type AccountFact =
	| { kind: "cooldown"; until: number }
	| { kind: "quarantine"; reason: string }
	| {
			kind: "rate-limit";
			info: RateLimitInfo;
			streaming: boolean;
			quotaRejected: boolean;
	  }
	| {
			kind: "message-id";
			thread: MessageThreadRequest;
			messageId: string | null;
	  };

export function applyAccountFact(
	account: Account,
	ctx: ResolvedPoolContext,
	fact: AccountFact,
): void {
	switch (fact.kind) {
		case "cooldown":
			account.rate_limited_until = fact.until;
			ctx.asyncWriter.enqueue(() =>
				ctx.dbOps.markAccountRateLimited(account.id, fact.until),
			);
			return;
		case "quarantine":
			quarantineAccount(account, ctx, fact.reason);
			return;
		case "rate-limit":
			if (!fact.streaming && fact.info.isRateLimited && !fact.quotaRejected)
				handleRateLimitResponse(account, fact.info, ctx);
			updateAccountMetadata(account, fact.info, ctx);
			return;
		case "message-id":
			rememberMessageThread(
				ctx.messageThreads,
				fact.thread,
				fact.messageId,
				account,
			);
	}
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
	ctx: ResolvedPoolContext,
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
	ctx: ResolvedPoolContext,
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
	ctx: ResolvedPoolContext,
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
