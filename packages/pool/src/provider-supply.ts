import type { ServeOutcome } from "@agent-smith/capacity";
import type { Account } from "@agent-smith/types";
import {
	attemptAccount,
	discardAttempt,
	resolvePerMinuteRateLimit,
	resolveQuotaRateLimit,
	resolveRequestScopedRateLimit,
	resolveTransportFailure,
	resolveUpstreamFailure,
} from "./account-attempts";
import type { PoolAttemptRequest } from "./attempt-executor";

/** Serve one provider without deciding whether the router should try another. */
export async function serveSelectedAccounts(
	request: PoolAttemptRequest,
	accounts: Account[],
	scope: "direct" | "pool-route",
): Promise<ServeOutcome> {
	if (accounts.length === 0)
		return { kind: "exhausted", reason: "no-eligible-account" };
	for (const [index, account] of accounts.entries()) {
		const attempt = await attemptAccount(request, account, index);
		if (attempt.kind === "response") {
			if (scope === "pool-route") {
				request.ctx.teamRouter?.rebind(
					request.teamRequest,
					account.id,
					request.ctx.runtime.teamRouting,
					request.ctx.provider,
					request.ctx.dbOps,
				);
			}
			return {
				kind: "final",
				response: attempt.response,
				providerServed: true,
			};
		}
		if (attempt.kind === "authentication-failure") {
			return {
				kind: "final",
				response: new Response("Bad Gateway", { status: 502 }),
				providerServed: false,
			};
		}
		if (attempt.kind === "provider-capacity-block") {
			if (scope === "pool-route" && accounts[index + 1]) {
				await attempt.discard?.();
				continue;
			}
			return {
				kind: "exhausted",
				reason: "capacity-block",
				block: attempt.block,
				forward: attempt.forward,
				discard: attempt.discard,
			};
		}
		if (attempt.kind === "per-minute-rate-limit") {
			return {
				kind: "final",
				response: await resolvePerMinuteRateLimit(
					request,
					account,
					index,
					attempt,
				),
				providerServed: false,
			};
		}
		if (attempt.kind === "request-scoped-rate-limit") {
			return {
				kind: "final",
				response: await resolveRequestScopedRateLimit(
					request,
					accounts,
					index,
					attempt,
				),
				providerServed: false,
			};
		}
		if (attempt.kind === "quota-rate-limit") {
			if (accounts[index + 1])
				return {
					kind: "final",
					response: await resolveQuotaRateLimit(
						request,
						accounts,
						index,
						attempt,
					),
					providerServed: false,
				};
			return {
				kind: "exhausted",
				reason: "quota",
				forward: attempt.forward,
				discard: attempt.discard,
			};
		}
		if (attempt.kind === "upstream-failure") {
			if (accounts[index + 1])
				return {
					kind: "final",
					response: await resolveUpstreamFailure(
						request,
						accounts,
						index,
						attempt,
					),
					providerServed: false,
				};
			return {
				kind: "exhausted",
				reason: "upstream-failure",
				forward: attempt.forward,
				discard: () => discardAttempt(attempt),
			};
		}
		if (attempt.kind === "transport-failure") {
			if (accounts[index + 1])
				return {
					kind: "final",
					response: await resolveTransportFailure(request, accounts, index),
					providerServed: false,
				};
			return { kind: "exhausted", reason: "transport" };
		}
	}
	return { kind: "exhausted", reason: "all-failed" };
}
