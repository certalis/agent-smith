import { describe, expect, it } from "bun:test";
import type { Account } from "@ccflare/types";
import type { ResolvedProxyContext } from "./proxy-types";
import { getValidAccessToken } from "./token-manager";

function account(expiresAt: number): Account {
	return {
		id: "account-1",
		name: "pooled-seat",
		provider: "claude-code",
		auth_method: "oauth",
		base_url: null,
		api_key: null,
		refresh_token: "refresh-old",
		access_token: "access-old",
		expires_at: expiresAt,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		weight: 1,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
	};
}

function context(): ResolvedProxyContext {
	return {
		provider: {
			name: "claude-code",
			defaultBaseUrl: "https://example.test",
			buildUrl: () => "https://example.test/v1/messages",
			prepareHeaders: (headers: Headers) => headers,
			parseRateLimit: () => ({ isRateLimited: false }),
			processResponse: async (response: Response) => response,
			refreshToken: async () => ({
				accessToken: "access-new",
				expiresAt: Date.now() + 60 * 60_000,
				refreshToken: "refresh-new",
			}),
		},
		providerName: "claude-code",
		upstreamPath: "/v1/messages",
		runtime: {
			clientId: "test-client",
			maxBodyBytes: 1,
			quotaThreshold: 0.98,
			requestScopedRetryDelayMs: 1,
			retry: { attempts: 1, delayMs: 1, backoff: 1 },
			sessionDurationMs: 1,
			port: 1,
		},
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: (task) => task(),
		} as ResolvedProxyContext["asyncWriter"],
		dbOps: {
			updateAccountTokens() {},
		} as unknown as ResolvedProxyContext["dbOps"],
	} as unknown as ResolvedProxyContext;
}

describe("getValidAccessToken", () => {
	it("refreshes five minutes before expiry", async () => {
		const selected = account(Date.now() + 4 * 60_000 + 59_000);

		expect(await getValidAccessToken(selected, context())).toBe("access-new");
		expect(selected.refresh_token).toBe("refresh-new");
	});
});
