import type { Account, ManualResetResult } from "@agent-smith/types";
import type { APIContext } from "../types";
import { parseJsonObject } from "../utils/json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body: unknown, status = 200) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Only registered behind the runtime's admin/Origin boundary, including GET. */
export function createResetCreditHandlers(context: APIContext) {
	const pending = new Set<string>();
	const accountFor = (id: string) => {
		const account = context.dbOps.getAccount(id);
		if (!account) return { error: reply({ error: "Account not found" }, 404) };
		const provider = context.providerRegistry.getProvider(account.provider);
		if (
			!provider?.supportsResetCredits?.(account) ||
			!provider.listResetCredits ||
			!provider.consumeResetCredit ||
			!provider.readResetQuota
		)
			return {
				error: reply(
					{ error: "Reset credits require a direct Codex subscription" },
					400,
				),
			};
		return { account, provider };
	};
	const accessToken = async (account: Account) => {
		if (!context.getAccountAccessToken)
			throw new Error("Token service unavailable");
		return context.getAccountAccessToken(account);
	};
	return {
		list: async (id: string): Promise<Response> => {
			const resolved = accountFor(id);
			if (resolved.error) return resolved.error;
			try {
				const { account, provider } = resolved;
				return reply(
					await provider.listResetCredits?.(
						account,
						await accessToken(account),
					),
				);
			} catch {
				return reply(
					{
						error:
							"Could not read Codex reset credits. Check this account's sign-in and try again.",
					},
					502,
				);
			}
		},
		consume: async (req: Request, id: string): Promise<Response> => {
			const resolved = accountFor(id);
			if (resolved.error) return resolved.error;
			let attempt: { creditId: string; requestId: string };
			try {
				const body = await parseJsonObject(req);
				if (
					body.confirmed !== true ||
					typeof body.creditId !== "string" ||
					body.creditId.trim().length === 0 ||
					body.creditId.length > 256 ||
					typeof body.requestId !== "string" ||
					!UUID.test(body.requestId) ||
					Object.keys(body).some(
						(key) => !["confirmed", "creditId", "requestId"].includes(key),
					)
				)
					return reply(
						{
							error:
								"Confirm the selected creditId and supply a UUID requestId",
						},
						400,
					);
				attempt = { creditId: body.creditId, requestId: body.requestId };
			} catch {
				return reply({ error: "Invalid reset request" }, 400);
			}
			if (pending.has(id))
				return reply(
					{ error: "A reset is already in progress for this account" },
					409,
				);
			pending.add(id);
			try {
				const { account, provider } = resolved;
				const token = await accessToken(account);
				const result = await provider.consumeResetCredit?.(
					account,
					token,
					attempt,
				);
				if (!result) throw new Error("Reset service unavailable");
				let quotaRefreshed = false;
				if (result.code === "reset" || result.code === "already_redeemed") {
					try {
						const quota = await provider.readResetQuota?.(account, token);
						const saved = context.dbOps.getAccount(id);
						if (
							quota &&
							saved &&
							saved.account_uuid === account.account_uuid &&
							saved.provider === account.provider
						) {
							context.dbOps.updateAccountQuotaState(id, {
								...saved.quota_state,
								windows: { ...saved.quota_state?.windows, ...quota.windows },
							});
							quotaRefreshed = true;
						}
					} catch {
						/* A consumed grant must never be reported as a failed redemption. */
					}
				}
				return reply({ ...result, quotaRefreshed } satisfies ManualResetResult);
			} catch {
				return reply(
					{
						error:
							"Codex reset outcome is unconfirmed. Retry the same creditId and requestId; do not use another reset to test.",
					},
					502,
				);
			} finally {
				pending.delete(id);
			}
		},
	};
}
