import { ServiceUnavailableError } from "@agent-smith/core";
import { Logger } from "@agent-smith/logger";
import type { Account } from "@agent-smith/types";
import { type AdmissionPermit, TeamAdmissionError } from "../team-admission";
import { type ProxyAttempt, proxyWithAccount } from "./proxy-operations";
import type { ProxyRequest } from "./proxy-request";
import { ERROR_MESSAGES } from "./proxy-types";
import { MAX_INLINE_RATE_LIMIT_RETRY_MS } from "./response-processor";

const log = new Logger("Proxy");

function createBodyStream(body: ArrayBuffer | null) {
	if (!body) return undefined;
	return new Response(body).body ?? undefined;
}

function releaseAfterResponse(
	response: Response,
	release: () => void,
): Response {
	if (!response.body) {
		release();
		return response;
	}
	const reader = response.body.getReader();
	let released = false;
	const finish = () => {
		if (released) return;
		released = true;
		release();
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					finish();
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				finish();
				controller.error(error);
			}
		},
		async cancel(reason) {
			finish();
			await reader.cancel(reason);
		},
	});
	return new Response(body, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
}

export function quotaExhaustionResponse(resetAt: number): Response {
	const retryAfterSeconds = Math.max(
		1,
		Math.ceil((resetAt - Date.now()) / 1000),
	);
	return new Response("All pooled accounts are out of quota", {
		status: 429,
		headers: { "retry-after": String(retryAfterSeconds) },
	});
}

export async function attemptAccount(
	request: ProxyRequest,
	account: Account,
	failoverAttempts: number,
): Promise<ProxyAttempt> {
	request.req.signal.throwIfAborted();
	const admission = request.ctx.teamAdmission;
	let permit: AdmissionPermit | undefined;
	try {
		permit = request.ctx.runtime.teamRouting.enabled
			? await admission?.acquire(
					account.id,
					request.ctx.runtime.teamRouting,
					request.req.signal,
				)
			: undefined;
	} catch (error) {
		if (error instanceof TeamAdmissionError) {
			throw new ServiceUnavailableError(
				error.message,
				request.ctx.providerName,
			);
		}
		throw error;
	}
	if (permit) request.ctx.teamRouter?.begin(account.id);
	request.ctx.outsideSpendTracker?.begin(account.id);
	const release = () => {
		permit?.release();
		if (permit) request.ctx.teamRouter?.end(account.id);
		request.ctx.outsideSpendTracker?.end(account.id);
	};
	try {
		const attempt = await proxyWithAccount(
			request.req,
			request.url,
			account,
			request.meta,
			request.body,
			(body) => createBodyStream(body),
			request.thread,
			failoverAttempts,
			request.mappedModel,
			request.ctx,
		);
		if (attempt.kind === "response") {
			const spentExtraUsage =
				request.ctx.provider.spendsExtraUsage?.(attempt.response) ?? false;
			return {
				...attempt,
				response: releaseAfterResponse(attempt.response, () => {
					release();
					if (spentExtraUsage) {
						request.ctx.seatAlerts?.extraUsageSpent(
							account,
							request.ctx.providerName,
						);
					}
				}),
			};
		}
		release();
		return attempt;
	} catch (error) {
		release();
		throw error;
	}
}

export async function resolvePerMinuteRateLimit(
	request: ProxyRequest,
	account: Account,
	failoverAttempts: number,
	attempt: Extract<ProxyAttempt, { kind: "per-minute-rate-limit" }>,
): Promise<Response> {
	if (attempt.retryAfterMs > MAX_INLINE_RATE_LIMIT_RETRY_MS) {
		return await attempt.forward();
	}

	if (attempt.retryAfterMs > 0) {
		await Bun.sleep(attempt.retryAfterMs);
	}

	const retryAttempt = await attemptAccount(request, account, failoverAttempts);
	if (retryAttempt.kind === "response") {
		return retryAttempt.response;
	}
	if (
		retryAttempt.kind === "per-minute-rate-limit" ||
		retryAttempt.kind === "request-scoped-rate-limit"
	) {
		return await retryAttempt.forward();
	}

	return await attempt.forward();
}

export async function resolveRequestScopedRateLimit(
	request: ProxyRequest,
	accounts: Account[],
	index: number,
	attempt: Extract<ProxyAttempt, { kind: "request-scoped-rate-limit" }>,
): Promise<Response> {
	const sibling = accounts[index + 1];
	if (!sibling) {
		return await attempt.forward();
	}
	request.ctx.teamAdmission?.armSwitch(sibling.id);

	const siblingAttempt = await attemptAccount(request, sibling, index + 1);
	if (siblingAttempt.kind === "response") {
		return siblingAttempt.response;
	}
	if (siblingAttempt.kind === "per-minute-rate-limit") {
		return await resolvePerMinuteRateLimit(
			request,
			sibling,
			index + 1,
			siblingAttempt,
		);
	}
	if (siblingAttempt.kind !== "request-scoped-rate-limit") {
		return await attempt.forward();
	}

	if (request.ctx.runtime.requestScopedRetryDelayMs > 0) {
		await Bun.sleep(request.ctx.runtime.requestScopedRetryDelayMs);
	}
	const retryAttempt = await attemptAccount(request, sibling, index + 1);
	if (retryAttempt.kind === "response") {
		return retryAttempt.response;
	}
	if (
		retryAttempt.kind === "per-minute-rate-limit" ||
		retryAttempt.kind === "request-scoped-rate-limit"
	) {
		return await retryAttempt.forward();
	}

	return await attempt.forward();
}

export async function resolveQuotaRateLimit(
	request: ProxyRequest,
	accounts: Account[],
	index: number,
	attempt: Extract<ProxyAttempt, { kind: "quota-rate-limit" }>,
): Promise<Response> {
	const sibling = accounts[index + 1];
	if (!sibling) return await attempt.forward();
	request.ctx.teamAdmission?.armSwitch(sibling.id);

	const siblingAttempt = await attemptAccount(request, sibling, index + 1);
	if (siblingAttempt.kind === "response") {
		request.ctx.teamRouter?.rebind(
			request.teamRequest,
			sibling.id,
			request.ctx.runtime.teamRouting,
			request.ctx.provider,
			request.ctx.dbOps,
		);
		return siblingAttempt.response;
	}
	if (siblingAttempt.kind === "authentication-failure") {
		return new Response("Bad Gateway", { status: 502 });
	}
	switch (siblingAttempt.kind) {
		case "quota-rate-limit":
		case "per-minute-rate-limit":
		case "request-scoped-rate-limit":
		case "upstream-failure":
			return await siblingAttempt.forward();
		default:
			return await attempt.forward();
	}
}

export async function resolveUpstreamFailure(
	request: ProxyRequest,
	accounts: Account[],
	index: number,
	attempt: Extract<ProxyAttempt, { kind: "upstream-failure" }>,
): Promise<Response> {
	const sibling = accounts[index + 1];
	if (!sibling) {
		return await attempt.forward();
	}
	request.ctx.teamAdmission?.armSwitch(sibling.id);

	const siblingAttempt = await attemptAccount(request, sibling, index + 1);
	if (siblingAttempt.kind === "response") {
		await discardAttempt(attempt);
		return siblingAttempt.response;
	}
	if (siblingAttempt.kind === "authentication-failure") {
		await discardAttempt(attempt);
		return new Response("Bad Gateway", { status: 502 });
	}
	switch (siblingAttempt.kind) {
		case "quota-rate-limit":
		case "per-minute-rate-limit":
		case "request-scoped-rate-limit":
		case "upstream-failure":
			await discardAttempt(attempt);
			return await siblingAttempt.forward();
		default:
			return await attempt.forward();
	}
}

export async function discardAttempt(
	attempt: Extract<ProxyAttempt, { kind: "upstream-failure" }>,
): Promise<void> {
	try {
		await attempt.discard?.();
	} catch (error) {
		log.warn(
			`Could not close a discarded upstream stream: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function resolveTransportFailure(
	request: ProxyRequest,
	accounts: Account[],
	index: number,
): Promise<Response> {
	const sibling = accounts[index + 1];
	if (!sibling) return new Response("Bad Gateway", { status: 502 });
	request.ctx.teamAdmission?.armSwitch(sibling.id);

	const siblingAttempt = await attemptAccount(request, sibling, index + 1);
	if (siblingAttempt.kind === "response") return siblingAttempt.response;
	switch (siblingAttempt.kind) {
		case "per-minute-rate-limit":
		case "request-scoped-rate-limit":
		case "upstream-failure":
			return await siblingAttempt.forward();
		default:
			return new Response("Bad Gateway", { status: 502 });
	}
}

export async function proxySelectedAccounts(
	request: ProxyRequest,
	accounts: Account[],
): Promise<Response> {
	for (let index = 0; index < accounts.length; index += 1) {
		const attempt = await attemptAccount(
			request,
			accounts[index] as Account,
			index,
		);
		if (attempt.kind === "response") return attempt.response;
		if (attempt.kind === "authentication-failure") {
			return new Response("Bad Gateway", { status: 502 });
		}
		if (attempt.kind === "per-minute-rate-limit") {
			return await resolvePerMinuteRateLimit(
				request,
				accounts[index] as Account,
				index,
				attempt,
			);
		}
		if (attempt.kind === "request-scoped-rate-limit") {
			return await resolveRequestScopedRateLimit(
				request,
				accounts,
				index,
				attempt,
			);
		}
		if (attempt.kind === "quota-rate-limit") {
			return await resolveQuotaRateLimit(request, accounts, index, attempt);
		}
		if (attempt.kind === "upstream-failure") {
			return await resolveUpstreamFailure(request, accounts, index, attempt);
		}
		if (attempt.kind === "transport-failure") {
			return await resolveTransportFailure(request, accounts, index);
		}
	}

	throw new ServiceUnavailableError(
		`${ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (${accounts.length} attempted)`,
		request.ctx.providerName,
	);
}
