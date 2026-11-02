import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { type Provider, ProviderRegistry } from "@ccflare/providers";
import type { Account } from "@ccflare/types";
import * as accountSelector from "./handlers/account-selector";
import type { ProxyContext } from "./handlers/proxy-types";
import {
	handleWebSocketUpgradeRequest,
	type WebSocketProxyData,
} from "./websocket-proxy";

const URL_UNDER_TEST = new URL("http://localhost:8080/v1/codex/responses");

function createTestProvider(): Provider {
	return {
		name: "codex",
		defaultBaseUrl: "https://codex.example.com",
		wire: "openai-responses",
		async refreshToken() {
			throw new Error("not implemented");
		},
		buildUrl(upstreamPath: string, query: string): string {
			return `https://codex.example.com${upstreamPath}${query}`;
		},
		prepareHeaders(headers: Headers): Headers {
			return new Headers(headers);
		},
		parseRateLimit() {
			return { isRateLimited: false };
		},
		quotaBucketsFor() {
			return undefined;
		},
		weeklyBucketFor() {
			return "unified7d";
		},
		isWeeklyBucket(bucket: string) {
			return bucket === "unified7d";
		},
		supportsQuotaProbe() {
			return false;
		},
		async probeQuota() {
			return null;
		},
		async processResponse(response: Response): Promise<Response> {
			return response;
		},
		getClientSessionId(headers: Headers) {
			return headers.get("session-id");
		},
		supportsWebSocket: () => true,
	};
}

function createTestAccount(): Account {
	return {
		id: "account-1",
		name: "codex-account",
		provider: "codex",
		access_token: "test-access-token",
		expires_at: Date.now() + 60 * 60 * 1000,
		refresh_token: "test-refresh-token",
	} as Account;
}

function createProxyContext(accounts: Account[]): ProxyContext {
	return {
		providerRegistry: new ProviderRegistry([createTestProvider()]),
		strategy: {
			select() {
				return accounts;
			},
		},
		dbOps: {
			getAllAccounts() {
				return accounts;
			},
			getAvailableAccountsByProvider() {
				return accounts;
			},
		},
		runtime: {
			clientId: "test-client",
			retry: { attempts: 1, delayMs: 0, backoff: 1 },
			sessionDurationMs: 0,
			port: 8080,
		},
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue() {},
		},
		usageWorker: {
			postMessage() {},
		} as unknown as Worker,
	} as unknown as ProxyContext;
}

function createUpgradeRequest(headers: HeadersInit = {}): Request {
	return new Request(URL_UNDER_TEST, {
		method: "GET",
		headers: {
			connection: "Upgrade",
			upgrade: "websocket",
			...headers,
		},
	});
}

afterEach(() => {
	mock.restore();
});

describe("handleWebSocketUpgradeRequest", () => {
	it("answers 503 and does not upgrade when no account is eligible", () => {
		const upgrade = mock(() => true);
		const server = { upgrade } as unknown as Bun.Server<WebSocketProxyData>;

		const response = handleWebSocketUpgradeRequest(
			createUpgradeRequest(),
			URL_UNDER_TEST,
			createProxyContext([]),
			server,
		);

		expect(response?.status).toBe(503);
		expect(upgrade).not.toHaveBeenCalled();
	});

	it("upgrades the connection when one account is eligible", () => {
		const upgrade = mock(() => true);
		const server = { upgrade } as unknown as Bun.Server<WebSocketProxyData>;

		const response = handleWebSocketUpgradeRequest(
			createUpgradeRequest(),
			URL_UNDER_TEST,
			createProxyContext([createTestAccount()]),
			server,
		);

		expect(response).toBeUndefined();
		expect(upgrade).toHaveBeenCalledTimes(1);
	});

	it("passes a Codex session ID into team pin selection", () => {
		const account = createTestAccount();
		const selectAccounts = spyOn(
			accountSelector,
			"selectAccountsForRequest",
		).mockReturnValue([account]);
		const upgrade = mock(() => true);
		const server = { upgrade } as unknown as Bun.Server<WebSocketProxyData>;

		handleWebSocketUpgradeRequest(
			createUpgradeRequest({ "session-id": "stable" }),
			URL_UNDER_TEST,
			createProxyContext([account]),
			server,
		);

		expect(selectAccounts).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				body: null,
				contentType: null,
				provider: "codex",
				sessionId: "stable",
			}),
		);
	});
});
