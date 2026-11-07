import { timingSafeEqual } from "node:crypto";

const FORWARDED_HEADERS = [
	"forwarded",
	"x-forwarded-for",
	"x-real-ip",
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MUTATING_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

export type ExposureConfig = {
	adminKey?: string;
	bindHost: string;
	bindHosts: readonly string[];
	proxyKey?: string;
	trustLoopback: boolean;
};

type RequestServer = Pick<Bun.Server<unknown>, "requestIP">;

function requestAddress(
	server: RequestServer | undefined,
	req: Request,
): {
	address: string | undefined;
	hasRequestIp: boolean;
} {
	if (!server || typeof server.requestIP !== "function") {
		return { address: undefined, hasRequestIp: false };
	}

	return {
		address: server.requestIP(req)?.address,
		hasRequestIp: true,
	};
}

function configuredKey(
	value: string | number | boolean | undefined,
): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function configuredBindHosts(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;

	const bindHosts = [
		...new Set(
			value
				.split(",")
				.map((host) => host.trim())
				.filter(Boolean),
		),
	];
	return bindHosts.length > 0 ? bindHosts : undefined;
}

export function createExposureConfig(config: {
	get(key: string): string | number | boolean | undefined;
}): ExposureConfig {
	const configuredHost =
		configuredKey(process.env.CF_HOST) ?? configuredKey(config.get("host"));
	const bindHosts = configuredBindHosts(process.env.CF_BIND_HOSTS) ?? [
		configuredHost ?? "127.0.0.1",
	];
	const configuredTrustLoopback = process.env.CF_TRUST_LOOPBACK;
	return {
		adminKey: configuredKey(process.env.CF_ADMIN_KEY),
		bindHost: bindHosts[0],
		bindHosts,
		proxyKey: configuredKey(process.env.CF_PROXY_KEY),
		trustLoopback:
			configuredTrustLoopback === undefined
				? config.get("trust_loopback") !== false
				: configuredTrustLoopback !== "false",
	};
}

export function isForwardedRequest(headers: Headers): boolean {
	return FORWARDED_HEADERS.some((header) => {
		const value = headers.get(header);
		return value !== null && value.trim().length > 0;
	});
}

export function isLoopbackAddress(address: string | undefined): boolean {
	return (
		address === "127.0.0.1" ||
		address === "::1" ||
		address === "::ffff:127.0.0.1"
	);
}

function safeKeyEqual(
	candidate: string | null,
	expected: string | undefined,
): boolean {
	if (!candidate || !expected || candidate.length !== expected.length) {
		return false;
	}

	return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

function bearerToken(req: Request): string | null {
	const authorization = req.headers.get("authorization");
	const match = authorization?.match(/^Bearer ([^\s]+)$/);
	return match?.[1] ?? null;
}

function isResponsesInferenceRoute(pathname: string): boolean {
	return (
		pathname === "/v1/codex/responses" ||
		pathname === "/v1/pool/openai-responses/responses"
	);
}

function keyRole(
	req: Request,
	url: URL,
	config: ExposureConfig,
): "admin" | "proxy" | null {
	const apiKey = req.headers.get("x-api-key");
	if (safeKeyEqual(apiKey, config.adminKey)) {
		return "admin";
	}
	if (safeKeyEqual(apiKey, config.proxyKey)) {
		return "proxy";
	}
	// Codex's Responses provider can only pass its configured credential as a
	// bearer token. Keep that compatibility path to the two wrapper endpoints:
	// it must never turn an Authorization header into OAuth or management access.
	if (
		isResponsesInferenceRoute(url.pathname) &&
		safeKeyEqual(bearerToken(req), config.proxyKey)
	) {
		return "proxy";
	}
	return null;
}

function hostnameFromHostHeader(host: string): string | undefined {
	try {
		const hostname = new URL(`http://${host}`).hostname.toLowerCase();
		return hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;
	} catch {
		return undefined;
	}
}

function isWildcardHost(host: string): boolean {
	return host === "0.0.0.0" || host === "::";
}

export function isLocalHostHeader(
	hostHeader: string | null,
	bindHosts: readonly string[] | string,
): boolean {
	if (hostHeader === null) {
		return true;
	}

	const hostname = hostnameFromHostHeader(hostHeader);
	if (!hostname) {
		return false;
	}

	const configuredHosts =
		typeof bindHosts === "string" ? [bindHosts] : bindHosts;
	return (
		LOOPBACK_HOSTS.has(hostname) ||
		configuredHosts.some(
			(bindHost) =>
				!isWildcardHost(bindHost) && hostname === bindHost.toLowerCase(),
		)
	);
}

function isSameOriginManagementRequest(req: Request, url: URL): boolean {
	const fetchSite = req.headers.get("sec-fetch-site");
	if (fetchSite) {
		return fetchSite === "same-origin" || fetchSite === "none";
	}

	const origin = req.headers.get("origin");
	return origin === null || origin === url.origin;
}

function jsonError(status: number, message: string): Response {
	return Response.json({ error: { message } }, { status });
}

/**
 * Enforces the server's external exposure boundary before API or proxy routing.
 * A same-host reverse proxy is treated as remote when it supplies forwarding
 * headers, preventing it from inheriting the direct-loopback exemption.
 */
export function exposureFailure(
	req: Request,
	url: URL,
	server: RequestServer | undefined,
	config: ExposureConfig,
): Response | null {
	const remote = requestAddress(server, req);
	const loopbackExempt =
		config.trustLoopback &&
		(remote.hasRequestIp
			? isLoopbackAddress(remote.address)
			: isLocalHostHeader(url.host, config.bindHosts)) &&
		!isForwardedRequest(req.headers);
	const role = keyRole(req, url, config);

	if (!role && !loopbackExempt) {
		return jsonError(401, "A proxy key is required for this request");
	}

	if (!role && !isLocalHostHeader(req.headers.get("host"), config.bindHosts)) {
		return jsonError(403, "Host header is not allowed for a loopback request");
	}

	if (url.pathname.startsWith("/api/")) {
		if (!isSameOriginManagementRequest(req, url)) {
			return jsonError(403, "Cross-origin management requests are not allowed");
		}

		if (MUTATING_METHODS.has(req.method)) {
			if (role !== "admin") {
				return jsonError(401, "An admin key is required for management writes");
			}
		}
	}

	return null;
}
