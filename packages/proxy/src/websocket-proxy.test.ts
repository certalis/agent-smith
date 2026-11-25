import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { type PoolContext, ProviderSupply } from "@agent-smith/pool";
import { type Provider, ProviderRegistry } from "@agent-smith/providers";
import type { Account } from "@agent-smith/types";
import type { ProxyContext } from "./handlers/proxy-types";
import { createProviderSupplies } from "./provider-supply-factory";
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
		isFiveHourBucket(bucket: string) {
			return bucket === "unified5h";
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
	const fixture = {
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
			getAccountsByProvider() {
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
	const pool = fixture as unknown as PoolContext;
	const context = {
		...fixture,
		routedProviders: new Map<string, ProviderSupply>(),
	};
	context.routedProviders = createProviderSupplies(pool, context);
	return context;
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
	it("answers 503 and does not upgrade when no account is eligible", async () => {
		const upgrade = mock(() => true);
		const server = { upgrade } as unknown as Bun.Server<WebSocketProxyData>;

		const response = await handleWebSocketUpgradeRequest(
			createUpgradeRequest(),
			URL_UNDER_TEST,
			createProxyContext([]),
			server,
		);

		expect(response?.status).toBe(503);
		expect(upgrade).not.toHaveBeenCalled();
	});

	it("upgrades the connection when one account is eligible", async () => {
		const upgrade = mock(() => true);
		const server = { upgrade } as unknown as Bun.Server<WebSocketProxyData>;

		const response = await handleWebSocketUpgradeRequest(
			createUpgradeRequest(),
			URL_UNDER_TEST,
			createProxyContext([createTestAccount()]),
			server,
		);

		expect(response).toBeUndefined();
		expect(upgrade).toHaveBeenCalledTimes(1);
	});

	it("passes a Codex session ID into team pin selection", async () => {
		const account = createTestAccount();
		const openSession = spyOn(ProviderSupply.prototype, "openSession");
		const upgrade = mock(() => true);
		const server = { upgrade } as unknown as Bun.Server<WebSocketProxyData>;

		await handleWebSocketUpgradeRequest(
			createUpgradeRequest({ "session-id": "stable" }),
			URL_UNDER_TEST,
			createProxyContext([account]),
			server,
		);

		expect(openSession).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "stable" }),
		);
	});
});

it("keeps account and authorization data behind an opaque websocket handle", async () => {
	const { createWebSocketSupplyAttempt } = await import("./websocket-proxy");
	const { createResolvedProxyContext } = await import("./handlers/proxy-types");
	const account = createTestAccount();
	const ctx = createProxyContext([account]);
	const provider = ctx.providerRegistry.getProvider("codex");
	if (!provider) throw new Error("provider missing");
	const requestContext = createResolvedProxyContext(
		ctx,
		provider,
		"/responses",
	);
	const req = createUpgradeRequest();
	const route = {
		scope: { kind: "direct", provider: "codex" },
		edge: {
			method: "GET",
			url: URL_UNDER_TEST,
			headers: req.headers,
			body: null,
			meta: {
				id: "test",
				method: "GET",
				path: URL_UNDER_TEST.pathname,
				timestamp: 0,
			},
		},
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: req.signal,
	} as const;
	const prepared = {
		req,
		url: URL_UNDER_TEST,
		ctx: {
			...requestContext,
			refreshInFlight: new Map<string, Promise<string>>(),
		},
		body: null,
		mappedModel: undefined,
		meta: route.edge.meta,
		teamRequest: {
			body: null,
			contentType: null,
			model: undefined,
			provider: "codex",
			sessionId: null,
		},
		thread: null,
		execute: async () => ({ kind: "failed" as const }),
	};
	const handle = await createWebSocketSupplyAttempt(ctx)(
		route,
		prepared,
		account,
	);
	expect(Reflect.ownKeys(handle)).toEqual([]);
	expect(JSON.stringify(handle)).not.toContain(account.access_token);
});
