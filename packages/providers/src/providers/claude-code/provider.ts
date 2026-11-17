import { Logger } from "@agent-smith/logger";
import {
	type Account,
	type AccountQuotaState,
	getProviderDefaultBaseUrl,
} from "@agent-smith/types";
import {
	deleteClientCredentialHeaders,
	deleteTransportHeaders,
} from "../../base";
import {
	executeTokenRefresh,
	type RefreshRequestConfig,
} from "../../token-refresh";
import type { TokenRefreshResult } from "../../types";
import { AnthropicProvider } from "../anthropic/provider";
import { CLAUDE_CODE_OAUTH_TOKEN_URL, ClaudeCodeOAuthProvider } from "./oauth";
import { fetchClaudeCodeUsage } from "./usage";

const log = new Logger("ClaudeCodeProvider");
const PROVIDER_NAME = "claude-code" as const;
const DEFAULT_BASE_URL = getProviderDefaultBaseUrl(PROVIDER_NAME);
const CHEAPEST_MODEL = "claude-haiku-5-5";
const WINDOW_WARMUP_TIMEOUT_MS = 30_000;

const CLAUDE_CODE_REFRESH_CONFIG: RefreshRequestConfig = {
	tokenUrl: CLAUDE_CODE_OAUTH_TOKEN_URL,
	contentType: "application/json",
	buildBody(refreshToken: string, clientId: string) {
		return JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: clientId,
		});
	},
	parseTokens(json: Record<string, unknown>, account: Account) {
		const refreshToken =
			(json.refresh_token as string) || (account.refresh_token ?? "");
		if (!json.refresh_token) {
			log.warn(
				`Claude Code refresh endpoint did not return a refresh_token for ${account.name} - continuing with previous one`,
			);
		}
		return {
			accessToken: json.access_token as string,
			expiresAt: Date.now() + (json.expires_in as number) * 1000,
			refreshToken,
		};
	},
};

export class ClaudeCodeProvider extends AnthropicProvider {
	name: string = PROVIDER_NAME;
	defaultBaseUrl: string = DEFAULT_BASE_URL;
	wire = "anthropic-messages" as const;

	supportsQuotaProbe(account: Account): boolean {
		return (
			account.auth_method === "oauth" &&
			!account.paused &&
			(!!account.access_token || !!account.refresh_token) &&
			!!account.account_uuid &&
			(account.base_url === null ||
				account.base_url.startsWith("https://api.anthropic.com"))
		);
	}

	async probeQuota(
		_account: Account,
		accessToken: string,
	): Promise<AccountQuotaState | null> {
		return await fetchClaudeCodeUsage(accessToken);
	}

	async startQuotaWindow(
		account: Account,
		accessToken: string,
		model: string | null,
	): Promise<AccountQuotaState | null> {
		const response = await fetch(this.buildUrl("/v1/messages", "", account), {
			method: "POST",
			headers: {
				authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: model ?? CHEAPEST_MODEL,
				max_tokens: 1,
				messages: [{ role: "user", content: "hi" }],
			}),
			signal: AbortSignal.timeout(WINDOW_WARMUP_TIMEOUT_MS),
		});
		await response.body?.cancel();
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return this.parseRateLimit(response).quotaState ?? null;
	}

	async refreshToken(
		account: Account,
		clientId: string,
	): Promise<TokenRefreshResult> {
		return executeTokenRefresh(
			account,
			clientId,
			CLAUDE_CODE_REFRESH_CONFIG,
			log,
		);
	}

	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const newHeaders = new Headers(headers);
		deleteClientCredentialHeaders(newHeaders);

		if (account?.access_token) {
			newHeaders.set("Authorization", `Bearer ${account.access_token}`);
		}

		// Remove api_key header -- Claude Code uses OAuth Bearer tokens
		newHeaders.delete("x-api-key");

		deleteTransportHeaders(newHeaders);

		return newHeaders;
	}

	supportsOAuth(): boolean {
		return true;
	}

	getOAuthProvider() {
		return new ClaudeCodeOAuthProvider();
	}
}
