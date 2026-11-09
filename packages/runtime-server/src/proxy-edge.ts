import {
	type IncomingHttpHeaders,
	type IncomingMessage,
	request,
	type ServerResponse,
} from "node:http";
import { isAbsolute } from "node:path";
import { isInferenceRoute } from "./inference-routes";

export type ProxyEdgeOptions = {
	origin: string;
	socketPath: string;
	maxBodyBytes?: number;
	timeoutMs?: number;
	maxConcurrentRequests?: number;
};

const REQUEST_HEADERS = [
	"content-type",
	"accept",
	"accept-encoding",
	"anthropic-version",
	"anthropic-beta",
	"x-api-key",
	"authorization",
	"x-claude-code-session-id",
	"session-id",
	"openai-beta",
	"x-client-request-id",
	"user-agent",
];
const RESPONSE_HEADERS = [
	"content-type",
	"content-encoding",
	"retry-after",
	"request-id",
	"x-request-id",
	"anthropic-ratelimit-requests-limit",
	"anthropic-ratelimit-requests-remaining",
	"anthropic-ratelimit-requests-reset",
	"anthropic-ratelimit-tokens-limit",
	"anthropic-ratelimit-tokens-remaining",
	"anthropic-ratelimit-tokens-reset",
];

function selectHeaders(
	headers: IncomingHttpHeaders,
	names: readonly string[],
): IncomingHttpHeaders {
	return Object.fromEntries(
		names.flatMap((name) =>
			typeof headers[name] === "string" ? [[name, headers[name]]] : [],
		),
	);
}

function requestFailure(
	req: IncomingMessage,
	origin: string,
	maxBodyBytes: number,
): number | null {
	const health = req.method === "GET" && req.url === "/pool-health";
	if (!health && !isInferenceRoute(req.method ?? "", req.url ?? "")) return 404;
	if (
		req.headers.host !== new URL(origin).host ||
		(req.headers.origin !== undefined && req.headers.origin !== origin) ||
		(req.headers["sec-fetch-site"] !== undefined &&
			!["none", "same-origin"].includes(String(req.headers["sec-fetch-site"])))
	)
		return 403;
	if (req.headers.upgrade || req.headers.expect) return 400;
	if (
		req.headers["content-length"] !== undefined &&
		(!/^\d+$/.test(req.headers["content-length"]) ||
			Number(req.headers["content-length"]) > maxBodyBytes)
	)
		return 413;
	if (!req.headers["x-api-key"] && !req.headers.authorization) return 401;
	return null;
}

/** A streaming, inference-only entrance to the existing private pool socket. */
export function createProxyEdgeHandler({
	origin,
	socketPath,
	maxBodyBytes = 64 * 1024 * 1024,
	timeoutMs = 300_000,
	maxConcurrentRequests = 128,
}: ProxyEdgeOptions) {
	const url = new URL(origin);
	if (
		url.protocol !== "https:" ||
		url.origin !== origin ||
		!isAbsolute(socketPath) ||
		!Number.isSafeInteger(maxBodyBytes) ||
		maxBodyBytes < 1 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		!Number.isSafeInteger(maxConcurrentRequests) ||
		maxConcurrentRequests < 1
	) {
		throw new Error(
			"Proxy edge requires an exact HTTPS origin, an absolute socket path and positive limits",
		);
	}
	let activeRequests = 0;
	return (req: IncomingMessage, res: ServerResponse) => {
		const finish = (status: number) => {
			if (res.writableEnded || res.destroyed) return;
			if (res.headersSent) {
				res.destroy();
				return;
			}
			res.writeHead(status, {
				"cache-control": "no-store",
				connection: "close",
			});
			res.end();
		};
		const rejected = requestFailure(req, origin, maxBodyBytes);
		if (rejected) return finish(rejected);
		if (activeRequests >= maxConcurrentRequests) return finish(503);
		activeRequests++;
		const path =
			req.method === "GET" && req.url === "/pool-health"
				? "/health"
				: (req.url ?? "");
		const headers = selectHeaders(req.headers, REQUEST_HEADERS);
		headers.host = "localhost";
		headers["x-forwarded-for"] = "proxy-edge";
		let upstreamResponse: IncomingMessage | undefined;
		const upstream = request(
			{ socketPath, path, method: req.method, headers, agent: false },
			(response) => {
				upstreamResponse = response;
				if (res.writableEnded || res.destroyed) {
					response.destroy();
					return;
				}
				const status = response.statusCode ?? 502;
				if (status >= 300 && status < 400) {
					response.destroy();
					finish(502);
					return;
				}
				res.writeHead(status, {
					...selectHeaders(response.headers, RESPONSE_HEADERS),
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				});
				response.once("error", () => res.destroy());
				response.once("aborted", () => res.destroy());
				response.pipe(res);
			},
		);
		const timer = setTimeout(() => {
			upstreamResponse?.destroy();
			upstream.destroy();
			finish(504);
		}, timeoutMs);
		res.once("close", () => {
			activeRequests--;
			clearTimeout(timer);
			upstreamResponse?.destroy();
			upstream.destroy();
		});
		upstream.once("error", (error: NodeJS.ErrnoException) => {
			console.error("Agent Smith private transport failed", error.code);
			finish(502);
		});
		req.once("aborted", () => upstream.destroy());
		req.once("error", () => upstream.destroy());
		let bytes = 0;
		req.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBodyBytes) {
				req.unpipe(upstream);
				upstream.destroy();
				finish(413);
			}
		});
		// Let the private pool reject bad keys before waiting for upload bytes.
		upstream.flushHeaders();
		req.pipe(upstream);
	};
}
