import type { APIRouter } from "@agent-smith/api";
import { HTTP_STATUS, ServiceUnavailableError } from "@agent-smith/core";
import { BadRequest, errorResponse } from "@agent-smith/http";
import {
	handleProxy,
	handleWebSocketUpgradeRequest,
	isWebSocketUpgradeRequest,
	type ProxyContext,
	prepareRequestBody,
	type WebSocketProxyData,
} from "@agent-smith/proxy";
import { serveDashboardRoute } from "./dashboard-assets";
import { type ExposureConfig, exposureFailure } from "./exposure";
import { forwardOAuthTokenRequest } from "./oauth-token";
import { hasDotSegment } from "./request-path";

type ServerFetchHandlerDependencies = {
	apiRouter: Pick<APIRouter, "handleRequest"> &
		Partial<Pick<APIRouter, "handleEnrollmentRequest">>;
	proxyContext: ProxyContext;
	withDashboard: boolean;
	exposureConfig?: ExposureConfig;
	isDeploymentDraining?: () => boolean;
	handleProxyRequest?: typeof handleProxy;
	handleWebSocketUpgrade?: typeof handleWebSocketUpgradeRequest;
	handleOAuthTokenRequest?: typeof forwardOAuthTokenRequest;
	serveDashboardAsset?: (url: URL) => Response | null;
};

export function createServerFetchHandler({
	apiRouter,
	proxyContext,
	withDashboard,
	exposureConfig = {
		bindHost: "127.0.0.1",
		trustLoopback: true,
	},
	handleProxyRequest = handleProxy,
	handleWebSocketUpgrade = handleWebSocketUpgradeRequest,
	handleOAuthTokenRequest = forwardOAuthTokenRequest,
	serveDashboardAsset = serveDashboardRoute,
	isDeploymentDraining = () => false,
}: ServerFetchHandlerDependencies) {
	return async (
		req: Request,
		server?: Bun.Server<WebSocketProxyData>,
	): Promise<Response | undefined> => {
		const url = new URL(req.url);
		if (hasDotSegment(req.url)) {
			return errorResponse(BadRequest("Invalid request path"));
		}

		const enrollmentResponse = apiRouter.handleEnrollmentRequest?.(url, req);
		if (enrollmentResponse) return enrollmentResponse;

		const rejected = exposureFailure(req, url, server, exposureConfig);
		if (rejected) {
			return rejected;
		}

		const apiResponse = await apiRouter.handleRequest(url, req);
		if (apiResponse) {
			return apiResponse;
		}

		if (url.pathname === "/v1/oauth/token") {
			try {
				const prepared = await prepareRequestBody(
					req,
					proxyContext.runtime.maxBodyBytes,
				);
				return await handleOAuthTokenRequest(req, prepared.buffer);
			} catch (error) {
				return errorResponse(error);
			}
		}

		const isProviderRoute =
			url.pathname === "/v1" ||
			url.pathname.startsWith("/v1/") ||
			url.pathname.startsWith("/tc-acct/");
		if (isProviderRoute) {
			if (isDeploymentDraining()) {
				return errorResponse(
					new ServiceUnavailableError(
						"Pool is draining for deployment",
						undefined,
						30,
					),
				);
			}
			if (server) {
				const websocketResponse = await handleWebSocketUpgrade(
					req,
					url,
					proxyContext,
					server,
				);
				if (websocketResponse) {
					return websocketResponse;
				}
				if (isWebSocketUpgradeRequest(req)) {
					return;
				}
			}

			try {
				return await handleProxyRequest(req, url, proxyContext);
			} catch (error) {
				return errorResponse(error);
			}
		}

		if (withDashboard && (req.method === "GET" || req.method === "HEAD")) {
			const dashboardResponse = serveDashboardAsset(url);
			if (dashboardResponse) {
				return dashboardResponse;
			}
		}

		return new Response("Not Found", { status: HTTP_STATUS.NOT_FOUND });
	};
}
