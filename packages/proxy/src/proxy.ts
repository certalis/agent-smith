import { requestEvents } from "@agent-smith/core";
import { Logger } from "@agent-smith/logger";
import { isRequestPayload, isRequestSummary } from "@agent-smith/types";
import {
	createRequestMetadata,
	type ProxyContext,
	prepareRequestBody,
	readRequestModel,
	resolveProxyContext,
	TIMING,
} from "./handlers";
import { routeDirectRequest, routePoolRequest } from "./router-bridge";
import {
	UsageWorkerController,
	type UsageWorkerHealthSnapshot,
	type UsageWorkerTransport,
} from "./usage-worker";

export type { ProxyContext } from "./handlers";

const log = new Logger("Proxy");

let usageWorkerInstance: UsageWorkerController | null = null;

type ManualPin = {
	accountName: string;
	url: URL;
};

function manualPinFromUrl(url: URL): ManualPin | "invalid" | undefined {
	if (!url.pathname.startsWith("/tc-acct/")) return undefined;
	const match = /^\/tc-acct\/([^/]+)(\/.*)$/.exec(url.pathname);
	if (!match) return "invalid";
	let accountName: string;
	try {
		accountName = decodeURIComponent(match[1]);
	} catch {
		return "invalid";
	}
	if (!/^[a-zA-Z0-9\s\-_@.+]+$/.test(accountName)) return "invalid";
	const upstreamUrl = new URL(url);
	upstreamUrl.pathname = match[2];
	return { accountName, url: upstreamUrl };
}

/**
 * Gets or creates the usage worker instance
 * @returns The usage worker instance
 */
export function getUsageWorker(): UsageWorkerTransport {
	if (usageWorkerInstance?.isShuttingDown()) {
		usageWorkerInstance.forceTerminate();
		usageWorkerInstance = null;
	}

	if (!usageWorkerInstance) {
		usageWorkerInstance = new UsageWorkerController({
			logger: log,
			shutdownDelayMs: TIMING.WORKER_SHUTDOWN_DELAY,
			onWorkerMessage: (data) => {
				if (data.type === "summary" && isRequestSummary(data.summary)) {
					requestEvents.emit("event", {
						type: "summary",
						payload: data.summary,
					});
				} else if (data.type === "payload" && isRequestPayload(data.payload)) {
					requestEvents.emit("event", {
						type: "payload",
						payload: data.payload,
					});
				}
			},
		});
	}
	return usageWorkerInstance;
}

export function getUsageWorkerHealth(): UsageWorkerHealthSnapshot {
	return (
		usageWorkerInstance?.getHealthSnapshot() ?? {
			state: "stopped",
			queuedMessages: 0,
			pendingAcks: 0,
			lastError: null,
		}
	);
}

/**
 * Gracefully terminates the usage worker
 */
export async function terminateUsageWorker(): Promise<void> {
	if (usageWorkerInstance) {
		const activeWorker = usageWorkerInstance;
		try {
			await usageWorkerInstance.terminateGracefully();
		} finally {
			if (usageWorkerInstance === activeWorker) {
				usageWorkerInstance = null;
			}
		}
	}
}

/**
 * Main proxy handler - orchestrates the entire proxy flow
 *
 * This function coordinates the proxy process by:
 * 1. Creating request metadata for tracking
 * 2. Selecting accounts based on load balancing strategy
 * 3. Emitting the ingress event and preparing the request body for reuse
 * 4. Attempting to proxy with each account in order
 *
 * A request with no eligible account is refused before any upstream call.
 *
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param ctx - The proxy context containing strategy, database, and provider
 * @returns Promise resolving to the proxied response
 * @throws {ServiceUnavailableError} If no account is eligible, or all accounts fail to proxy the request
 */
export async function handleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	callerId?: string,
): Promise<Response> {
	const manualPin = manualPinFromUrl(url);
	if (manualPin === "invalid")
		return new Response("Not Found", { status: 404 });
	if (manualPin && !ctx.dbOps.getAccountByName(manualPin.accountName)) {
		return new Response("Not Found", { status: 404 });
	}
	const upstreamUrl = manualPin?.url ?? url;
	const requestContext = resolveProxyContext(upstreamUrl, ctx);
	if (!requestContext) {
		if (!upstreamUrl.pathname.startsWith("/v1/pool/")) {
			return new Response("Not Found", { status: 404 });
		}
		const requestMeta = createRequestMetadata(req, upstreamUrl, callerId);
		const { buffer } = await prepareRequestBody(req, ctx.runtime.maxBodyBytes);
		const body = buffer ?? null;
		requestMeta.model = readRequestModel(body);
		const pool = ctx.providerRegistry.resolvePool(
			upstreamUrl.pathname,
			requestMeta.model,
		);
		if (!pool) return new Response("Not Found", { status: 404 });
		if (pool.providers.length === 0) {
			return new Response(
				`No provider in provider_pools.${pool.wire} serves the requested model`,
				{ status: 400 },
			);
		}
		return await routePoolRequest(
			req,
			upstreamUrl,
			ctx,
			requestMeta,
			body,
			pool,
			manualPin?.accountName,
			callerId,
		);
	}
	const requestMeta = createRequestMetadata(req, upstreamUrl, callerId);
	const { buffer } = await prepareRequestBody(
		req,
		requestContext.runtime.maxBodyBytes,
	);
	const body = buffer ?? null;
	requestMeta.model = readRequestModel(body);
	return routeDirectRequest(
		req,
		upstreamUrl,
		ctx,
		requestContext,
		requestMeta,
		body,
		manualPin?.accountName,
		callerId,
		url.pathname,
	);
}
