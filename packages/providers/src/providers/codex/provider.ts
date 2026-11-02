import { Logger } from "@ccflare/logger";
import {
	type Account,
	type AccountQuotaState,
	getProviderDefaultBaseUrl,
	isRecord,
} from "@ccflare/types";
import {
	deleteClientCredentialHeaders,
	deleteTransportHeaders,
} from "../../base";
import {
	executeTokenRefresh,
	type RefreshRequestConfig,
} from "../../token-refresh";
import type { TokenRefreshResult } from "../../types";
import {
	OpenAIProvider,
	parseInteger,
	parseResetTime,
} from "../openai/provider";
import {
	CODEX_OAUTH_CLIENT_ID,
	CODEX_OAUTH_TOKEN_URL,
	CodexOAuthProvider,
} from "./oauth";

const CODEX_CLIENT_VERSION = "0.118.0";
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLIENT_VERSION} (Mac OS; arm64)`;
const log = new Logger("CodexProvider");
const PROVIDER_NAME = "codex" as const;
const DEFAULT_BASE_URL = getProviderDefaultBaseUrl(PROVIDER_NAME);
const CODEX_WINDOW_BUCKETS: ReadonlyMap<number, "unified5h" | "unified7d"> =
	new Map([
		[300, "unified5h"],
		[10_080, "unified7d"],
	]);
const CODEX_WINDOW_POSITIONS = ["primary", "secondary"] as const;

function isEnvironmentContext(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "input_text" &&
		typeof value.text === "string" &&
		/^<environment_context>\r?\n[\s\S]*<\/environment_context>\s*$/.test(
			value.text,
		)
	);
}

function normalizeOpening(entry: unknown): unknown | null {
	if (isEnvironmentContext(entry)) return null;
	if (!isRecord(entry) || !Array.isArray(entry.content)) return entry;
	const content = entry.content.filter((block) => !isEnvironmentContext(block));
	return content.length > 0 ? { ...entry, content } : null;
}

function isQuotaRejectionPayload(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const error = isRecord(value.error) ? value.error : undefined;
	return (
		value.type === "usage_limit_reached" ||
		value.code === "usage_limit_reached" ||
		error?.type === "usage_limit_reached" ||
		error?.code === "usage_limit_reached"
	);
}

function parseCodexUsagePercent(value: string | null): number | null {
	if (value === null || value.trim() === "") return null;
	const percent = Number(value);
	return Number.isFinite(percent) && percent >= 0 && percent <= 100
		? percent / 100
		: null;
}

function parseCodexResetTime(
	response: Response,
	prefix: string,
): number | null {
	const resetAt = parseResetTime(response.headers.get(`${prefix}-reset-at`));
	if (resetAt !== undefined) return resetAt;

	const resetAfterHeader = response.headers.get(
		`${prefix}-reset-after-seconds`,
	);
	if (resetAfterHeader === null) return null;
	if (resetAfterHeader.trim() === "") return null;

	const resetAfterSeconds = Number(resetAfterHeader);
	return Number.isFinite(resetAfterSeconds) && resetAfterSeconds >= 0
		? Date.now() + resetAfterSeconds * 1000
		: null;
}

function parseCodexQuotaState(
	response: Response,
): AccountQuotaState | undefined {
	const windows: AccountQuotaState["windows"] = {};
	const seenAt = Date.now();

	for (const position of CODEX_WINDOW_POSITIONS) {
		const prefix = `x-codex-${position}`;
		const minutes = parseInteger(
			response.headers.get(`${prefix}-window-minutes`),
		);
		const bucket =
			minutes === undefined ? undefined : CODEX_WINDOW_BUCKETS.get(minutes);
		if (!bucket || windows[bucket]) continue;
		const resetAt = parseCodexResetTime(response, prefix);
		const utilization = parseCodexUsagePercent(
			response.headers.get(`${prefix}-used-percent`),
		);
		if (resetAt === null && utilization === null) continue;

		windows[bucket] = {
			resetAt,
			seenAt,
			status: null,
			utilization,
		};
	}

	return Object.keys(windows).length > 0 ? { windows } : undefined;
}

const CODEX_REFRESH_CONFIG: RefreshRequestConfig = {
	tokenUrl: CODEX_OAUTH_TOKEN_URL,
	contentType: "application/x-www-form-urlencoded",
	buildBody(refreshToken: string, _clientId: string) {
		return new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CODEX_OAUTH_CLIENT_ID,
		}).toString();
	},
	parseTokens(json: Record<string, unknown>, account: Account) {
		const expiresAt =
			(json.expires_at as number | undefined) ??
			Date.now() + ((json.expires_in as number | undefined) ?? 3600) * 1000;
		return {
			accessToken: json.access_token as string,
			expiresAt,
			refreshToken:
				(json.refresh_token as string | undefined) ??
				account.refresh_token ??
				"",
		};
	},
};

export class CodexProvider extends OpenAIProvider {
	name: string = PROVIDER_NAME;
	defaultBaseUrl: string = DEFAULT_BASE_URL;
	wire = "openai-responses" as const;

	getClientSessionId(headers: Headers): string | null {
		return headers.get("session-id");
	}

	getConversationOpening(payload: unknown): unknown | null {
		if (!isRecord(payload) || !Array.isArray(payload.input)) return null;
		for (const entry of payload.input) {
			const opening = normalizeOpening(entry);
			if (opening !== null) return opening;
		}
		return null;
	}

	async isQuotaRejection(response: Response): Promise<boolean> {
		if (response.status !== 429) return false;
		try {
			return isQuotaRejectionPayload(await response.clone().json());
		} catch {
			return false;
		}
	}

	hasRateLimitSignal(headerName: string): boolean {
		return (
			super.hasRateLimitSignal(headerName) ||
			/^x-codex-(?:primary|secondary)-(?:used-percent|reset-at)$/i.test(
				headerName,
			)
		);
	}

	weeklyBucketFor(_model: string | undefined): string {
		return "unified7d";
	}

	isWeeklyBucket(bucket: string): boolean {
		return bucket === "unified7d";
	}

	supportsWebSocket(upstreamPath: string): boolean {
		return upstreamPath === "/responses";
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		return executeTokenRefresh(account, _clientId, CODEX_REFRESH_CONFIG, log);
	}

	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const newHeaders = new Headers(headers);
		deleteClientCredentialHeaders(newHeaders);

		if (account?.access_token) {
			newHeaders.set("Authorization", `Bearer ${account.access_token}`);
		}

		// Codex-specific headers
		newHeaders.set("originator", "codex_cli_rs");
		newHeaders.set("User-Agent", CODEX_USER_AGENT);
		newHeaders.set("Version", CODEX_CLIENT_VERSION);
		newHeaders.set("Openai-Beta", "responses=experimental");

		// Remove Anthropic-family headers that don't belong on Codex requests
		newHeaders.delete("x-api-key");
		newHeaders.delete("anthropic-version");

		deleteTransportHeaders(newHeaders);

		return newHeaders;
	}

	parseRateLimit(response: Response) {
		const quotaState = parseCodexQuotaState(response);
		const activeLimit = response.headers.get("x-codex-active-limit")?.trim();
		const resets = [
			parseResetTime(response.headers.get("x-codex-5h-reset-at")),
			parseResetTime(response.headers.get("x-codex-7d-reset-at")),
			...Object.values(quotaState?.windows ?? {}).flatMap((window) =>
				window.resetAt === null ? [] : [window.resetAt],
			),
		].filter((value): value is number => value !== undefined);

		if (quotaState || activeLimit || resets.length > 0) {
			const isRateLimited = response.status === 429;

			return {
				...(activeLimit && { activeLimit }),
				isRateLimited,
				quotaState,
				resetTime: resets.length > 0 ? Math.min(...resets) : undefined,
				statusHeader: isRateLimited ? "rate_limited" : "allowed",
			};
		}

		return super.parseRateLimit(response);
	}

	supportsOAuth(): boolean {
		return true;
	}

	getOAuthProvider() {
		return new CodexOAuthProvider();
	}

	getOAuthCallbackForwarder() {
		return {
			port: 1455,
			targetPath: "/oauth/codex/callback",
		};
	}
}
