import { sanitizeProxyHeaders } from "@ccflare/http";
import type { Account, AccountQuotaState, ProviderWire } from "@ccflare/types";
import type { Provider, RateLimitInfo } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeConversationOpening(opening: unknown): unknown {
	if (!isRecord(opening) || typeof opening.content !== "string") {
		return opening;
	}
	const content = opening.content
		.replace(/^Claude Code billing header: [^\r\n]*(?:\r?\n|$)/, "")
		.replace(/(?:^|\n)<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "");
	return { ...opening, content };
}

/**
 * Headers that are provider-neutral transport artifacts and should always be
 * removed before forwarding a request upstream.
 */
const TRANSPORT_HEADERS_TO_DELETE = [
	"host",
	"accept-encoding",
	"content-encoding",
	"transfer-encoding",
] as const;

const CLIENT_CREDENTIAL_HEADERS_TO_DELETE = [
	"api-key",
	"authorization",
	"cookie",
	"proxy-authorization",
	"x-api-key",
] as const;

/**
 * Remove provider-neutral transport headers from a Headers object.
 * Auth-specific headers (Authorization, x-api-key, anthropic-version, etc.)
 * are NOT touched here -- those belong to the concrete providers.
 */
export function deleteTransportHeaders(headers: Headers): void {
	for (const h of TRANSPORT_HEADERS_TO_DELETE) {
		headers.delete(h);
	}
}

/**
 * Remove credentials supplied by the proxy client before adding the selected
 * pooled account's authentication. A missing account credential must never
 * turn the caller's credential into an upstream fallback.
 */
export function deleteClientCredentialHeaders(headers: Headers): void {
	for (const h of CLIENT_CREDENTIAL_HEADERS_TO_DELETE) {
		headers.delete(h);
	}
}

export abstract class BaseProvider implements Provider {
	abstract name: string;
	abstract defaultBaseUrl: string;
	abstract wire: ProviderWire;

	/**
	 * Build the target URL for the provider.
	 * Default: trim trailing slashes from the base URL and append path + query.
	 * Override only if a provider needs genuinely different URL construction.
	 */
	buildUrl(upstreamPath: string, query: string, account?: Account): string {
		const baseUrl = (account?.base_url ?? this.defaultBaseUrl).replace(
			/\/+$/,
			"",
		);
		return `${baseUrl}${upstreamPath}${query}`;
	}

	quotaBucketsFor(_model: string | undefined): readonly string[] | undefined {
		return undefined;
	}

	weeklyBucketFor(_model: string | undefined): string | undefined {
		return undefined;
	}

	isWeeklyBucket(_bucket: string): boolean {
		return false;
	}

	isFiveHourBucket(_bucket: string): boolean {
		return false;
	}

	getClientSessionId(headers: Headers): string | null {
		return headers.get("x-claude-code-session-id");
	}

	getConversationOpening(payload: unknown): unknown | null {
		if (!isRecord(payload) || !Array.isArray(payload.messages)) return null;
		return payload.messages.length > 0
			? normalizeConversationOpening(payload.messages[0])
			: null;
	}

	async isQuotaRejection(_response: Response): Promise<boolean> {
		return false;
	}

	hasRateLimitSignal(headerName: string): boolean {
		return headerName.toLowerCase() === "retry-after";
	}

	supportsQuotaProbe(_account: Account): boolean {
		return false;
	}

	async probeQuota(
		_account: Account,
		_accessToken: string,
	): Promise<AccountQuotaState | null> {
		return null;
	}

	/**
	 * Prepare headers for the provider request.
	 * Default implementation: add Bearer auth from the account (if present)
	 * and remove provider-neutral transport headers.
	 * Subclasses should call super or use deleteTransportHeaders() to get the
	 * transport cleanup, then layer on auth-specific headers.
	 */
	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const newHeaders = new Headers(headers);
		deleteClientCredentialHeaders(newHeaders);
		if (account?.access_token) {
			newHeaders.set("Authorization", `Bearer ${account.access_token}`);
		}
		deleteTransportHeaders(newHeaders);
		return newHeaders;
	}

	/**
	 * Parse rate limit information from response
	 * Default implementation: use only provider-neutral 429 and Retry-After signals.
	 * Providers with their own quota headers override this method.
	 */
	parseRateLimit(response: Response): RateLimitInfo {
		if (response.status !== 429) {
			return { isRateLimited: false };
		}

		// Try to extract reset time from headers
		const retryAfter = response.headers.get("retry-after");
		let resetTime: number | undefined;

		if (retryAfter) {
			// Retry-After can be seconds or HTTP date
			const seconds = Number(retryAfter);
			if (!Number.isNaN(seconds)) {
				resetTime = Date.now() + seconds * 1000;
			} else {
				resetTime = new Date(retryAfter).getTime();
			}
		}

		return { isRateLimited: true, resetTime };
	}

	/**
	 * Process the response before returning to client.
	 * Default implementation: sanitize hop-by-hop proxy headers.
	 * Override only if a provider needs custom response transformation.
	 */
	async processResponse(
		response: Response,
		_account: Account | null,
	): Promise<Response> {
		const headers = sanitizeProxyHeaders(response.headers);

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	/**
	 * Extract usage information from response if available
	 * Default implementation: Return null (no usage info)
	 */
	async extractUsageInfo?(_response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
	} | null> {
		return null;
	}

	/**
	 * Check if the response is a streaming response
	 * Default implementation: Check for text/event-stream or stream in content-type
	 */
	isStreamingResponse?(response: Response): boolean {
		const contentType = response.headers.get("content-type") ?? "";
		return (
			contentType.includes("text/event-stream") ||
			contentType.includes("stream")
		);
	}
}
