import { TokenRefreshError } from "@agent-smith/core";
import { Logger } from "@agent-smith/logger";
import type { AccountFact, ResolvedPoolContext } from "@agent-smith/pool";
import { ProviderRequestTransformError } from "@agent-smith/providers";
import { stripProviderChoiceHeaders } from "@agent-smith/routing";
import type { Account, RequestMeta } from "@agent-smith/types";
import type { ProxyAttempt } from "../attempt-executor";
import { forwardToClient } from "../response-handler";
import { type MessageThreadRequest, readMessageId } from "./message-thread";
import type { ResolvedProxyContext } from "./proxy-types";
import { rewriteRequestBody } from "./request-body-rewriter";
import { makeProxyRequest } from "./request-handler";
import {
	getPerMinuteRetryAfterMs,
	handleProxyError,
	isOrganizationForbidden,
	isQuotaRejection,
	isRequestScopedRateLimit,
	isUpstreamFailureResponse,
} from "./response-processor";
import { inspectStreamHead } from "./stream-failure";
import { getValidAccessToken, refreshAccessTokenSafe } from "./token-manager";

const API_KEY_AUTH_COOLDOWN_MS = 5 * 60_000;
const ORGANIZATION_QUARANTINE_MS = 5 * 60_000;
const log = new Logger("ProxyOperations");

type BodyStreamFactory = (
	body: ArrayBuffer | null,
) => ReadableStream<Uint8Array> | undefined;

type UpstreamResponse = {
	response: Response;
	responseHeadersReceivedAt: number;
	upstreamRequestStartedAt: number;
};

type SendUpstream = (token: string) => Promise<UpstreamResponse>;

type ProxyOperationInput = {
	account: Account;
	createBodyStream: BodyStreamFactory;
	ctx: ResolvedProxyContext;
	pool: ResolvedPoolContext;
	failoverAttempts: number;
	mappedModel: string | undefined;
	requestBody: ArrayBuffer | null;
	requestMeta: RequestMeta;
	req: Request;
	thread: MessageThreadRequest | null;
	url: URL;
	inlineRateLimitRetry: boolean;
	report: (fact: AccountFact) => void;
};

/**
 * Attempts to proxy a request with a specific account
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param account - The account to use
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param failoverAttempts - Number of failover attempts
 * @param ctx - The proxy context
 * @returns A forwarded response, a retryable 429, or a failed attempt
 */
export type { ProxyAttempt } from "../attempt-executor";

function createUpstreamSender(input: ProxyOperationInput): SendUpstream {
	const transformed = input.ctx.provider.transformRequest?.({
		body: input.requestBody,
		headers: input.req.headers,
		mappedModel: input.mappedModel,
		query: input.url.search,
		upstreamPath: input.ctx.upstreamPath,
	});
	const targetUrl = input.ctx.provider.buildUrl(
		transformed?.upstreamPath ?? input.ctx.upstreamPath,
		transformed?.query ?? input.url.search,
		input.account,
	);
	return async (token) => {
		const requestAccount =
			token === input.account.access_token
				? input.account
				: { ...input.account, access_token: token };
		const headers = input.ctx.provider.prepareHeaders(
			stripProviderChoiceHeaders(input.req.headers),
			requestAccount,
		);
		const upstreamRequestStartedAt = Date.now();
		const response = await makeProxyRequest(
			targetUrl,
			input.req.method,
			headers,
			() => input.createBodyStream(transformed?.body ?? input.requestBody),
			!!input.req.body,
			input.req.signal,
		);
		return {
			response,
			responseHeadersReceivedAt: Date.now(),
			upstreamRequestStartedAt,
		};
	};
}

async function sendAuthorizedRequest(
	input: ProxyOperationInput,
	send: SendUpstream,
): Promise<ProxyAttempt | UpstreamResponse> {
	let accessToken = await getValidAccessToken(input.account, input.pool);
	let upstream = await send(accessToken);
	if (upstream.response.status !== 401) return upstream;

	if (input.account.auth_method === "api_key") {
		const until = Date.now() + API_KEY_AUTH_COOLDOWN_MS;
		input.report({ kind: "cooldown", until });
		return { kind: "failed" };
	}
	if (!input.account.refresh_token) {
		input.report({ kind: "quarantine", reason: "missing OAuth refresh token" });
		return { kind: "failed" };
	}

	try {
		accessToken = await refreshAccessTokenSafe(input.account, input.pool);
		upstream = await send(accessToken);
	} catch {
		return { kind: "failed" };
	}

	return upstream.response.status === 401
		? { kind: "authentication-failure" }
		: upstream;
}

function isProxyAttempt(
	value: ProxyAttempt | UpstreamResponse,
): value is ProxyAttempt {
	return "kind" in value;
}

function createForwarder(
	input: ProxyOperationInput,
	upstream: UpstreamResponse,
	state: { response: Response },
): () => Promise<Response> {
	return async () =>
		await forwardToClient(
			{
				requestId: input.requestMeta.id,
				method: input.requestMeta.method,
				path: input.url.pathname,
				account: input.account,
				requestHeaders: input.req.headers,
				requestBody: input.requestBody,
				response: state.response,
				timestamp: input.requestMeta.timestamp,
				upstreamRequestStartedAt: upstream.upstreamRequestStartedAt,
				responseHeadersReceivedAt: upstream.responseHeadersReceivedAt,
				retryAttempt: 0,
				failoverAttempts: input.failoverAttempts,
				preExtractedModel: input.mappedModel ?? input.requestMeta.model,
			},
			input.ctx,
		);
}

function discardUpstreamResponse(state: {
	response: Response;
}): () => Promise<void> {
	return async () => {
		await state.response.body?.cancel();
	};
}

function recordResponseFacts(
	input: ProxyOperationInput,
	response: Response,
	quotaRejected: boolean,
): boolean {
	const streaming = input.ctx.provider.isStreamingResponse?.(response) ?? false;
	const info = input.ctx.provider.parseRateLimit(response);
	input.report({ kind: "rate-limit", info, streaming, quotaRejected });
	return !streaming && info.isRateLimited;
}

async function classifyUpstreamResponse(
	input: ProxyOperationInput,
	upstream: UpstreamResponse,
): Promise<ProxyAttempt> {
	const state = { response: upstream.response };
	if (await isOrganizationForbidden(state.response)) {
		const until = Date.now() + ORGANIZATION_QUARANTINE_MS;
		input.report({ kind: "cooldown", until });
		return { kind: "failed" };
	}

	let response = state.response;
	const forward = createForwarder(input, upstream, state);
	const interactive = input.inlineRateLimitRetry;
	const capacityBlock = await input.ctx.provider.getCapacityBlock?.(response);
	if (capacityBlock) {
		const quotaRejected = await isQuotaRejection(response, input.ctx.provider);
		recordResponseFacts(input, response, quotaRejected);
		const perMinuteRetryAfterMs = getPerMinuteRetryAfterMs(
			response,
			quotaRejected,
		);
		if (
			interactive &&
			(capacityBlock.category === "request-rate" ||
				capacityBlock.category === "burst")
		) {
			if (perMinuteRetryAfterMs !== undefined) {
				return {
					forward,
					kind: "per-minute-rate-limit",
					retryAfterMs: perMinuteRetryAfterMs,
				};
			}
		}
		return {
			block: capacityBlock,
			discard: discardUpstreamResponse(state),
			forward,
			kind: "provider-capacity-block",
		};
	}

	if (isRequestScopedRateLimit(response, input.ctx.provider)) {
		return { forward, kind: "request-scoped-rate-limit" };
	}
	if (isUpstreamFailureResponse(response)) {
		return { forward, kind: "upstream-failure" };
	}
	const streamHead = await inspectStreamHead(
		response,
		input.ctx.provider.isStreamingResponse?.(response) ?? false,
	);
	response = streamHead.response;
	state.response = response;
	if (streamHead.failure) {
		return {
			discard: streamHead.discard,
			forward,
			kind: "upstream-failure",
		};
	}

	const quotaRejected = await isQuotaRejection(response, input.ctx.provider);
	const isRateLimited = recordResponseFacts(input, response, quotaRejected);
	const perMinuteRetryAfterMs = getPerMinuteRetryAfterMs(
		response,
		quotaRejected,
	);
	if (perMinuteRetryAfterMs !== undefined) {
		return {
			forward,
			kind: "per-minute-rate-limit",
			retryAfterMs: perMinuteRetryAfterMs,
		};
	}
	if (isRateLimited && !response.ok) {
		return response.status === 429
			? {
					discard: discardUpstreamResponse(state),
					forward,
					kind: "quota-rate-limit",
				}
			: { kind: "failed" };
	}

	if (response.ok && input.thread) {
		const messageId = streamHead.messageId ?? (await readMessageId(response));
		input.report({ kind: "message-id", thread: input.thread, messageId });
	}
	return { kind: "response", response: await forward() };
}

export async function proxyWithAccount(
	req: Request,
	url: URL,
	account: Account,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: BodyStreamFactory,
	thread: MessageThreadRequest | null,
	failoverAttempts: number,
	mappedModel: string | undefined,
	ctx: ResolvedProxyContext,
	pool: ResolvedPoolContext,
	inlineRateLimitRetry: boolean,
	report: (fact: AccountFact) => void,
): Promise<ProxyAttempt> {
	const input: ProxyOperationInput = {
		account,
		createBodyStream,
		ctx,
		pool,
		failoverAttempts,
		mappedModel,
		requestBody: requestBodyBuffer
			? rewriteRequestBody(
					requestBodyBuffer,
					account.account_uuid,
					ctx.upstreamPath,
					req.headers.get("content-type"),
					mappedModel,
				)
			: null,
		requestMeta,
		req,
		thread,
		url,
		inlineRateLimitRetry,
		report,
	};
	try {
		log.info(`Attempting request with account: ${account.name}`);
		const upstream = await sendAuthorizedRequest(
			input,
			createUpstreamSender(input),
		);
		return isProxyAttempt(upstream)
			? upstream
			: await classifyUpstreamResponse(input, upstream);
	} catch (err) {
		// A client cancellation is not a provider failure to retry elsewhere.
		req.signal.throwIfAborted();
		if (err instanceof ProviderRequestTransformError) {
			return {
				kind: "response",
				response: new Response(err.message, { status: 400 }),
			};
		}
		handleProxyError(err, account, log);
		return err instanceof TokenRefreshError
			? { kind: "failed" }
			: { kind: "transport-failure" };
	}
}
