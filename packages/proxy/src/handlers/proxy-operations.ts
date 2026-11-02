import { TokenRefreshError } from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import type { Account, RequestMeta } from "@ccflare/types";
import { forwardToClient } from "../response-handler";
import {
	type MessageThreadRequest,
	readMessageId,
	rememberMessageThread,
} from "./message-thread";
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
	processProxyResponse,
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
	failoverAttempts: number;
	requestBody: ArrayBuffer | null;
	requestMeta: RequestMeta;
	req: Request;
	thread: MessageThreadRequest | null;
	url: URL;
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
export type ProxyAttempt =
	| { kind: "authentication-failure" }
	| { kind: "failed" }
	| { kind: "transport-failure" }
	| {
			forward: () => Promise<Response>;
			kind: "per-minute-rate-limit";
			retryAfterMs: number;
	  }
	| { kind: "response"; response: Response }
	| {
			discard?: () => Promise<void>;
			forward: () => Promise<Response>;
			kind: "quota-rate-limit";
	  }
	| { forward: () => Promise<Response>; kind: "request-scoped-rate-limit" }
	| {
			discard?: () => Promise<void>;
			forward: () => Promise<Response>;
			kind: "upstream-failure";
	  };

function shouldQuarantineAfterRefreshFailure(error: unknown): boolean {
	if (!(error instanceof TokenRefreshError)) return false;
	const status = (error.originalError as { status?: unknown } | undefined)
		?.status;
	return typeof status === "number" && status >= 400 && status < 500;
}

function quarantineAccount(
	account: Account,
	ctx: ResolvedProxyContext,
	reason: string,
): void {
	account.paused = true;
	account.error_reason = reason;
	ctx.asyncWriter.enqueue(() => ctx.dbOps.markAccountError(account.id, reason));
}

function createUpstreamSender(input: ProxyOperationInput): SendUpstream {
	const targetUrl = input.ctx.provider.buildUrl(
		input.ctx.upstreamPath,
		input.url.search,
		input.account,
	);
	return async (token) => {
		const requestAccount =
			token === input.account.access_token
				? input.account
				: { ...input.account, access_token: token };
		const headers = input.ctx.provider.prepareHeaders(
			input.req.headers,
			requestAccount,
		);
		const upstreamRequestStartedAt = Date.now();
		const response = await makeProxyRequest(
			targetUrl,
			input.req.method,
			headers,
			() => input.createBodyStream(input.requestBody),
			!!input.req.body,
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
	let accessToken = await getValidAccessToken(input.account, input.ctx);
	let upstream = await send(accessToken);
	if (upstream.response.status !== 401) return upstream;

	if (input.account.auth_method === "api_key") {
		const until = Date.now() + API_KEY_AUTH_COOLDOWN_MS;
		input.account.rate_limited_until = until;
		input.ctx.asyncWriter.enqueue(() =>
			input.ctx.dbOps.markAccountRateLimited(input.account.id, until),
		);
		return { kind: "failed" };
	}
	if (!input.account.refresh_token) {
		quarantineAccount(input.account, input.ctx, "missing OAuth refresh token");
		return { kind: "failed" };
	}

	try {
		accessToken = await refreshAccessTokenSafe(input.account, input.ctx);
		upstream = await send(accessToken);
	} catch (error) {
		if (shouldQuarantineAfterRefreshFailure(error)) {
			quarantineAccount(
				input.account,
				input.ctx,
				"OAuth refresh was rejected by the upstream",
			);
		}
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

async function classifyUpstreamResponse(
	input: ProxyOperationInput,
	upstream: UpstreamResponse,
): Promise<ProxyAttempt> {
	const state = { response: upstream.response };
	if (await isOrganizationForbidden(state.response)) {
		const until = Date.now() + ORGANIZATION_QUARANTINE_MS;
		input.account.rate_limited_until = until;
		input.ctx.asyncWriter.enqueue(() =>
			input.ctx.dbOps.markAccountRateLimited(input.account.id, until),
		);
		return { kind: "failed" };
	}

	let response = state.response;
	const forward = createForwarder(input, upstream, state);

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
	const isRateLimited = processProxyResponse(
		response,
		input.account,
		input.ctx,
		quotaRejected,
	);
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
	if (isRateLimited) {
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
		rememberMessageThread(
			input.ctx.messageThreads,
			input.thread,
			messageId,
			input.account,
		);
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
): Promise<ProxyAttempt> {
	const input: ProxyOperationInput = {
		account,
		createBodyStream,
		ctx,
		failoverAttempts,
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
		handleProxyError(err, account, log);
		return err instanceof TokenRefreshError
			? { kind: "failed" }
			: { kind: "transport-failure" };
	}
}
