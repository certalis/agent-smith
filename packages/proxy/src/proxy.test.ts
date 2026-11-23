import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import { WINDOW_WARMUP_DEFAULTS } from "@agent-smith/config";
import { requestEvents, ServiceUnavailableError } from "@agent-smith/core";
import { type Provider, ProviderRegistry } from "@agent-smith/providers";
import type { Account } from "@agent-smith/types";
import { handleProxy, type ProxyContext } from "./proxy";
import { TeamRouter } from "./team-router";

const originalFetch = globalThis.fetch;

function createTestProvider(
	name: string,
	capacityBlock?: ProviderCapacityBlock,
): Provider {
	return {
		name,
		defaultBaseUrl: `https://${name}.example.com`,
		wire: "anthropic-messages",
		async refreshToken(_account: Account, _clientId: string) {
			throw new Error("not implemented");
		},
		buildUrl(upstreamPath: string, query: string, account?: Account): string {
			return `${account?.base_url ?? this.defaultBaseUrl}${upstreamPath}${query}`;
		},
		prepareHeaders(headers: Headers): Headers {
			return new Headers(headers);
		},
		parseRateLimit() {
			return { isRateLimited: false };
		},
		async getCapacityBlock(response: Response) {
			return response.status === 429 ? (capacityBlock ?? null) : null;
		},
		quotaBucketsFor() {
			return undefined;
		},
		weeklyBucketFor() {
			return undefined;
		},
		isWeeklyBucket() {
			return false;
		},
		isFiveHourBucket() {
			return false;
		},
		getClientSessionId(headers: Headers) {
			return headers.get("x-claude-code-session-id");
		},
		getConversationOpening(payload: unknown) {
			return typeof payload === "object" && payload !== null
				? ((payload as { messages?: unknown }).messages ?? null)
				: null;
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
	};
}

function createTestAccount(): Account {
	return {
		id: "account-1",
		name: "test-account",
		provider: "anthropic",
		access_token: "test-access-token",
		expires_at: Date.now() + 60 * 60 * 1000,
		refresh_token: "test-refresh-token",
	} as Account;
}

function createProxyContext(
	providers: Provider[],
	accounts: Account[] = [],
	providerPools: Record<string, readonly string[]> = {},
): ProxyContext {
	const preferences = new Map<
		string,
		{ provider: string; promotionDeclined: boolean; lastSeenAt: number }
	>();
	const providerBlocks = new Map<
		string,
		{ category: string; lastSeenAt: number; retryAt: number | undefined }
	>();
	return {
		providerRegistry: new ProviderRegistry(providers, {
			providerPools,
		}),
		strategy: {
			select(eligible: Account[]) {
				return eligible;
			},
		},
		dbOps: {
			getEnrollmentContact() {
				return null;
			},
			getAllAccounts() {
				return accounts;
			},
			getAccountsByProvider(provider: string) {
				return accounts.filter((account) => account.provider === provider);
			},
			getAvailableAccountsByProvider(provider: string) {
				return accounts.filter((account) => account.provider === provider);
			},
			getConversationProviderPreference(pinKey: string) {
				return preferences.get(pinKey) ?? null;
			},
			upsertConversationProviderPreference(
				pinKey: string,
				provider: string,
				promotionDeclined: boolean,
				lastSeenAt: number,
			) {
				preferences.set(pinKey, {
					provider,
					promotionDeclined,
					lastSeenAt,
				});
			},
			getConversationProviderBlock(pinKey: string, provider: string) {
				return providerBlocks.get(`${pinKey}\u0000${provider}`) ?? null;
			},
			upsertConversationProviderBlock(
				pinKey: string,
				provider: string,
				category: string,
				retryAt: number | undefined,
				lastSeenAt: number,
			) {
				providerBlocks.set(`${pinKey}\u0000${provider}`, {
					category,
					lastSeenAt,
					retryAt,
				});
			},
			deleteConversationProviderBlock(pinKey: string, provider: string) {
				providerBlocks.delete(`${pinKey}\u0000${provider}`);
			},
		},
		runtime: {
			blockWhenAllFull: true,
			clientId: "test-client",
			quotaThreshold: 0.9,
			retry: {
				attempts: 1,
				delayMs: 0,
				backoff: 1,
			},
			sessionDurationMs: 0,
			port: 8080,
			teamRouting: {
				enabled: false,
				distributionEnabled: true,
				preferExpiringQuota: false,
				allowlistedAccountUuids: [],
				maxUsage: 0.9,
				weeklyMaxUsage: 0.9,
				weeklyMaxUsageByEmail: {},
				admissionCap: 5,
				admissionQueueLimit: 25,
				admissionWaitMs: 30_000,
				holdSeconds: 0,
				quotaProbeSeconds: 0,
				windowWarmup: WINDOW_WARMUP_DEFAULTS,
			},
		},
		refreshInFlight: new Map(),
		teamRouter: new TeamRouter(),
		asyncWriter: {
			enqueue() {},
		},
		usageWorker: {
			postMessage() {},
		} as unknown as Worker,
	} as unknown as ProxyContext;
}

afterEach(() => {
	requestEvents.removeAllListeners("event");
	globalThis.fetch = originalFetch;
	mock.restore();
});

describe("handleProxy routing", () => {
	it("returns 404 for an unknown provider", async () => {
		const response = await handleProxy(
			new Request("http://localhost:8080/v1/google/v1/chat", {
				method: "POST",
			}),
			new URL("http://localhost:8080/v1/google/v1/chat"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(response.status).toBe(404);
	});

	it("returns 404 for a bare /v1/ path", async () => {
		const response = await handleProxy(
			new Request("http://localhost:8080/v1/"),
			new URL("http://localhost:8080/v1/"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(response.status).toBe(404);
	});

	it("matches providers case-sensitively", async () => {
		const response = await handleProxy(
			new Request("http://localhost:8080/v1/Anthropic/v1/messages", {
				method: "POST",
			}),
			new URL("http://localhost:8080/v1/Anthropic/v1/messages"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(response.status).toBe(404);
	});

	it("refuses with 503 and makes no upstream call when no account is eligible", async () => {
		const fetchMock = mock(() => Promise.resolve(new Response("ok")));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const events: Array<unknown> = [];
		requestEvents.on("event", (event) => {
			events.push(event);
		});

		const error: unknown = await handleProxy(
			new Request("http://localhost:8080/v1/anthropic/v1/messages", {
				method: "POST",
			}),
			new URL("http://localhost:8080/v1/anthropic/v1/messages"),
			createProxyContext([createTestProvider("anthropic")]),
		).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(ServiceUnavailableError);
		expect((error as ServiceUnavailableError).statusCode).toBe(503);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(events).not.toContainEqual(
			expect.objectContaining({ type: "ingress" }),
		);
	});

	it("emits an ingress event before the upstream response is available", async () => {
		const fetchControl: { resolve?: (response: Response) => void } = {};
		const fetchPromise = new Promise<Response>((resolve) => {
			fetchControl.resolve = resolve;
		});
		const fetchMock = mock(() => fetchPromise);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const events: Array<unknown> = [];
		requestEvents.on("event", (event) => {
			events.push(event);
		});

		const responsePromise = handleProxy(
			new Request("http://localhost:8080/v1/anthropic/v1/messages", {
				method: "POST",
			}),
			new URL("http://localhost:8080/v1/anthropic/v1/messages"),
			createProxyContext(
				[createTestProvider("anthropic")],
				[createTestAccount()],
			),
		);

		// W2 reads the request body before account selection so a thread
		// continuation can be pinned. Yield once for that async preparation;
		// ingress must still precede the unresolved upstream response.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(events).toContainEqual({
			type: "ingress",
			id: expect.any(String),
			timestamp: expect.any(Number),
			method: "POST",
			path: "/v1/anthropic/v1/messages",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const resolveFetch = fetchControl.resolve;
		if (!resolveFetch) {
			throw new Error("Expected fetch resolver to be assigned");
		}
		resolveFetch(new Response("ok", { status: 200 }));
		const response = await responsePromise;

		expect(response.status).toBe(200);
	});

	it("returns an interactive provider chooser instead of silently moving a blocked Model Studio turn", async () => {
		const qwen = createTestProvider("qwen-claude", {
			category: "token-allocation",
		});
		const kimi = createTestProvider("kimi-claude");
		const qwenAccount = {
			...createTestAccount(),
			id: "qwen-account",
			provider: "qwen-claude",
		} as Account;
		const kimiAccount = {
			...createTestAccount(),
			id: "kimi-account",
			provider: "kimi-claude",
		} as Account;
		const seenHeaders: Headers[] = [];
		const fetchMock = mock((url: string, init?: RequestInit) => {
			seenHeaders.push(new Headers(init?.headers));
			return Promise.resolve(
				url.includes("qwen-claude")
					? new Response(
							JSON.stringify({ code: "Throttling.AllocationQuota" }),
							{
								status: 429,
								headers: { "content-type": "application/json" },
							},
						)
					: new Response(JSON.stringify({ ok: true })),
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const body = '{"model":"claude-sonnet-4-5","messages":[]}';

		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-agent-smith-interactive-provider-choice": "v1",
					},
					body,
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			createProxyContext([qwen, kimi], [qwenAccount, kimiAccount], {
				"anthropic-messages": ["qwen-claude", "kimi-claude"],
			}),
		);

		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({
			blockedProvider: "qwen-claude",
			category: "token-allocation",
			choices: [{ provider: "kimi-claude" }],
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			seenHeaders[0]?.get("x-agent-smith-interactive-provider-choice"),
		).toBeNull();
	});

	it("returns a noninteractive burst block without serving the next provider", async () => {
		const qwen = createTestProvider("qwen-claude", { category: "burst" });
		qwen.parseRateLimit = () => ({ isRateLimited: true });
		const kimi = createTestProvider("kimi-claude");
		const accounts = [
			{ ...createTestAccount(), id: "qwen-account", provider: "qwen-claude" },
			{ ...createTestAccount(), id: "kimi-account", provider: "kimi-claude" },
		] as Account[];
		const urls: string[] = [];
		globalThis.fetch = mock((url: string) => {
			urls.push(url);
			return Promise.resolve(
				url.includes("qwen-claude")
					? new Response("limited", { status: 429 })
					: new Response("served by kimi"),
			);
		}) as unknown as typeof fetch;
		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: '{"model":"claude-sonnet-4-5","messages":[]}',
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			createProxyContext([qwen, kimi], accounts, {
				"anthropic-messages": ["qwen-claude", "kimi-claude"],
			}),
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBeNull();
		expect(await response.json()).toMatchObject({
			blockedProvider: "qwen-claude",
			category: "burst",
		});
		expect(urls).toEqual(["https://qwen-claude.example.com/v1/messages"]);
	});

	it("moves an ordered-fallback caller to the next provider after a capacity block", async () => {
		const qwen = createTestProvider("qwen-claude", {
			category: "token-allocation",
		});
		const kimi = createTestProvider("kimi-claude");
		const accounts = [
			{
				...createTestAccount(),
				id: "qwen-account",
				provider: "qwen-claude",
				auth_method: "oauth",
				account_uuid: "qwen-seat",
			},
			{
				...createTestAccount(),
				id: "kimi-account",
				provider: "kimi-claude",
				auth_method: "api_key",
				api_key: "kimi-api-key",
			},
		] as Account[];
		const urls: string[] = [];
		globalThis.fetch = mock((url: string) => {
			urls.push(url);
			return Promise.resolve(
				url.includes("qwen-claude")
					? new Response("limited", { status: 429 })
					: new Response("served by kimi"),
			);
		}) as unknown as typeof fetch;
		const context = createProxyContext([qwen, kimi], accounts, {
			"anthropic-messages": ["qwen-claude", "kimi-claude"],
		});
		Object.assign(context.runtime.teamRouting, {
			enabled: true,
			allowlistedAccountUuids: ["qwen-seat"],
			callerProviderFallback: { "agents-box": "ordered" },
		});

		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: '{"model":"claude-sonnet-4-5","messages":[]}',
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			context,
			"agents-box",
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("served by kimi");
		expect(urls).toEqual([
			"https://qwen-claude.example.com/v1/messages",
			"https://kimi-claude.example.com/v1/messages",
		]);
	});

	it("keeps an interactive policy caller on a blocked provider until a choice is sent", async () => {
		const qwen = createTestProvider("qwen-claude", {
			category: "token-allocation",
		});
		const kimi = createTestProvider("kimi-claude");
		const accounts = [
			{
				...createTestAccount(),
				id: "qwen-account",
				provider: "qwen-claude",
				auth_method: "oauth",
				account_uuid: "qwen-seat",
			},
			{
				...createTestAccount(),
				id: "kimi-account",
				provider: "kimi-claude",
				auth_method: "api_key",
				api_key: "kimi-api-key",
			},
		] as Account[];
		const urls: string[] = [];
		globalThis.fetch = mock((url: string) => {
			urls.push(url);
			return Promise.resolve(
				url.includes("qwen-claude")
					? new Response("limited", { status: 429 })
					: new Response("served by kimi"),
			);
		}) as unknown as typeof fetch;
		const context = createProxyContext([qwen, kimi], accounts, {
			"anthropic-messages": ["qwen-claude", "kimi-claude"],
		});
		Object.assign(context.runtime.teamRouting, {
			enabled: true,
			allowlistedAccountUuids: ["qwen-seat"],
			callerProviderFallback: { "agents-box": "ordered" },
		});

		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-agent-smith-interactive-provider-choice": "v1",
					},
					body: '{"model":"claude-sonnet-4-5","messages":[]}',
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			context,
			"agents-box",
		);

		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({
			blockedProvider: "qwen-claude",
		});
		expect(urls).toEqual(["https://qwen-claude.example.com/v1/messages"]);
	});

	it("moves an ordered-fallback caller past a Claude seat at its weekly ceiling", async () => {
		const claude = createTestProvider("claude-code");
		claude.isWeeklyBucket = (bucket) => bucket === "unified7d";
		const kimi = createTestProvider("kimi-claude");
		const resetAt = Date.now() + 7 * 24 * 60 * 60 * 1_000;
		const accounts = [
			{
				...createTestAccount(),
				id: "claude-account",
				provider: "claude-code",
				auth_method: "oauth",
				account_uuid: "claude-seat",
				quota_state: {
					windows: {
						unified7d: {
							resetAt,
							seenAt: Date.now(),
							status: "allowed",
							utilization: 0.7,
						},
					},
				},
			},
			{
				...createTestAccount(),
				id: "kimi-account",
				provider: "kimi-claude",
				auth_method: "api_key",
				api_key: "kimi-api-key",
			},
		] as Account[];
		const urls: string[] = [];
		globalThis.fetch = mock((url: string) => {
			urls.push(url);
			return Promise.resolve(new Response("served by kimi"));
		}) as unknown as typeof fetch;
		const context = createProxyContext([claude, kimi], accounts, {
			"anthropic-messages": ["claude-code", "kimi-claude"],
		});
		Object.assign(context.runtime.teamRouting, {
			enabled: true,
			allowlistedAccountUuids: ["claude-seat"],
			callerWeeklyMaxUsage: { "agents-box": 0.7 },
			callerProviderFallback: { "agents-box": "ordered" },
		});

		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: '{"model":"claude-sonnet-4-5","messages":[]}',
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			context,
			"agents-box",
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("served by kimi");
		expect(urls).toEqual(["https://kimi-claude.example.com/v1/messages"]);
	});

	it("returns a noninteractive rate block with its upstream retry time", async () => {
		const retryAt = Date.now() + 60_000;
		const qwen = createTestProvider("qwen-claude", {
			category: "request-rate",
			retryAt,
		});
		qwen.parseRateLimit = () => ({ isRateLimited: true, resetTime: retryAt });
		const kimi = createTestProvider("kimi-claude");
		const accounts = [
			{ ...createTestAccount(), id: "qwen-account", provider: "qwen-claude" },
			{ ...createTestAccount(), id: "kimi-account", provider: "kimi-claude" },
		] as Account[];
		const urls: string[] = [];
		globalThis.fetch = mock((url: string) => {
			urls.push(url);
			return Promise.resolve(
				url.includes("qwen-claude")
					? new Response("limited", {
							status: 429,
							headers: { "retry-after": "60" },
						})
					: new Response("served by kimi"),
			);
		}) as unknown as typeof fetch;
		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: '{"model":"claude-sonnet-4-5","messages":[]}',
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			createProxyContext([qwen, kimi], accounts, {
				"anthropic-messages": ["qwen-claude", "kimi-claude"],
			}),
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).not.toBeNull();
		expect(await response.json()).toMatchObject({
			blockedProvider: "qwen-claude",
			category: "request-rate",
			wait: { retryAt },
		});
		expect(urls).toEqual(["https://qwen-claude.example.com/v1/messages"]);
	});

	it("offers a chooser when the pinned provider has no eligible account before an upstream attempt", async () => {
		const qwen = createTestProvider("qwen-claude");
		const kimi = createTestProvider("kimi-claude");
		const kimiAccount = {
			...createTestAccount(),
			id: "kimi-account",
			provider: "kimi-claude",
		} as Account;
		const fetchMock = mock(() => Promise.resolve(new Response("unexpected")));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-agent-smith-interactive-provider-choice": "v1",
					},
					body: '{"model":"claude-sonnet-4-5","messages":[]}',
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			createProxyContext([qwen, kimi], [kimiAccount], {
				"anthropic-messages": ["qwen-claude", "kimi-claude"],
			}),
		);

		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({
			blockedProvider: "qwen-claude",
			category: "unknown",
			choices: [{ provider: "kimi-claude" }],
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("identifies a prefiltered Claude five-hour quota block", async () => {
		const claude = createTestProvider("claude-code");
		claude.quotaBucketsFor = () => ["unified5h", "unified7d"];
		claude.isFiveHourBucket = (bucket) => bucket === "unified5h";
		claude.isWeeklyBucket = (bucket) => bucket === "unified7d";
		const retryAt = Date.now() + 60_000;
		const account = {
			...createTestAccount(),
			provider: "claude-code",
			quota_state: {
				windows: {
					unified5h: {
						resetAt: retryAt,
						seenAt: Date.now(),
						status: "rejected",
						utilization: null,
					},
				},
			},
		} as Account;
		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-agent-smith-interactive-provider-choice": "v1",
					},
					body: '{"model":"claude-sonnet-4-5","messages":[]}',
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			createProxyContext([claude], [account], {
				"anthropic-messages": ["claude-code"],
			}),
		);

		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({
			category: "five-hour-limit",
			wait: { retryAt },
		});
	});

	it("tries every account of a blocked provider before asking to switch providers", async () => {
		const qwen = createTestProvider("qwen-claude", {
			category: "token-allocation",
		});
		const first = {
			...createTestAccount(),
			id: "qwen-first",
			provider: "qwen-claude",
		} as Account;
		const second = {
			...createTestAccount(),
			id: "qwen-second",
			name: "second-qwen",
			provider: "qwen-claude",
		} as Account;
		const fetchMock = mock(() =>
			Promise.resolve(new Response("limited", { status: 429 })),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-agent-smith-interactive-provider-choice": "v1",
					},
					body: '{"model":"claude-sonnet-4-5","messages":[]}',
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			createProxyContext([qwen], [first, second], {
				"anthropic-messages": ["qwen-claude"],
			}),
		);

		expect(response.status).toBe(429);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("handles a short Model Studio throttle without opening the provider chooser", async () => {
		const qwen = createTestProvider("qwen-claude", {
			category: "burst",
		});
		qwen.parseRateLimit = () => ({ isRateLimited: true });
		const account = {
			...createTestAccount(),
			provider: "qwen-claude",
		} as Account;
		const fetchMock = mock(() =>
			Promise.resolve(
				new Response("limited", {
					status: 429,
					headers: { "retry-after": "0" },
				}),
			),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-agent-smith-interactive-provider-choice": "v1",
					},
					body: '{"model":"claude-sonnet-4-5","messages":[]}',
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			createProxyContext([qwen], [account], {
				"anthropic-messages": ["qwen-claude"],
			}),
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("x-agent-smith-provider-capacity")).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("keeps a Model Studio rate block without a deadline classified and pinned", async () => {
		const qwen = createTestProvider("qwen-claude", { category: "burst" });
		qwen.parseRateLimit = () => ({ isRateLimited: true });
		const account = {
			...createTestAccount(),
			provider: "qwen-claude",
		} as Account;
		const fetchMock = mock(() =>
			Promise.resolve(new Response("limited", { status: 429 })),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);
		const context = createProxyContext([qwen], [account], {
			"anthropic-messages": ["qwen-claude"],
		});
		const request = (headers: Record<string, string> = {}) =>
			new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-agent-smith-interactive-provider-choice": "v1",
					"x-claude-code-session-id": "model-studio-burst",
					...headers,
				},
				body: '{"model":"claude-sonnet-4-5","messages":[]}',
			});

		const first = await handleProxy(request(), url, context);
		expect(await first.json()).toMatchObject({
			category: "burst",
			wait: null,
		});

		const waited = await handleProxy(
			request({ "x-agent-smith-provider-wait": "v1" }),
			url,
			context,
		);
		expect(await waited.json()).toMatchObject({
			category: "burst",
			wait: null,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("opens the full ranked chooser only when the Claude session explicitly asks again", async () => {
		const qwen = createTestProvider("qwen-claude");
		const kimi = createTestProvider("kimi-claude");
		const accounts = [
			{ ...createTestAccount(), id: "qwen-account", provider: "qwen-claude" },
			{ ...createTestAccount(), id: "kimi-account", provider: "kimi-claude" },
		] as Account[];
		const fetchMock = mock(() => Promise.resolve(new Response("unexpected")));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-agent-smith-interactive-provider-choice": "v1",
						"x-agent-smith-provider-menu": "v1",
					},
					body: '{"model":"claude-sonnet-4-5","messages":[]}',
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			createProxyContext([qwen, kimi], accounts, {
				"anthropic-messages": ["qwen-claude", "kimi-claude"],
			}),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			activeProvider: "qwen-claude",
			choices: [{ provider: "qwen-claude" }, { provider: "kimi-claude" }],
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("retries the blocked turn on the provider the person selected without forwarding control headers", async () => {
		const qwen = createTestProvider("qwen-claude", {
			category: "token-allocation",
		});
		const kimi = createTestProvider("kimi-claude");
		const qwenAccount = {
			...createTestAccount(),
			id: "qwen-account",
			provider: "qwen-claude",
		} as Account;
		const kimiAccount = {
			...createTestAccount(),
			id: "kimi-account",
			provider: "kimi-claude",
		} as Account;
		const upstreamBodies: string[] = [];
		const upstreamHeaders: Headers[] = [];
		const fetchMock = mock(async (url: string, init?: RequestInit) => {
			upstreamBodies.push(await new Response(init?.body).text());
			upstreamHeaders.push(new Headers(init?.headers));
			return new Response(JSON.stringify({ provider: url }), { status: 200 });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const body =
			'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"keep this context"}]}';

		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-agent-smith-interactive-provider-choice": "v1",
						"x-agent-smith-provider-choice": "kimi-claude",
					},
					body,
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			createProxyContext([qwen, kimi], [qwenAccount, kimiAccount], {
				"anthropic-messages": ["qwen-claude", "kimi-claude"],
			}),
		);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await response.json()).toEqual({
			provider: "https://kimi-claude.example.com/v1/messages",
		});
		expect(upstreamBodies).toEqual([body]);
		expect(
			upstreamHeaders[0]?.get("x-agent-smith-interactive-provider-choice"),
		).toBeNull();
		expect(upstreamHeaders[0]?.get("x-agent-smith-provider-choice")).toBeNull();
	});

	it("keeps a selected provider for title requests with a different opening", async () => {
		const qwen = createTestProvider("qwen-claude");
		const kimi = createTestProvider("kimi-claude");
		const accounts = [
			{ ...createTestAccount(), id: "qwen-account", provider: "qwen-claude" },
			{ ...createTestAccount(), id: "kimi-account", provider: "kimi-claude" },
		] as Account[];
		const urls: string[] = [];
		const fetchMock = mock((url: string) => {
			urls.push(url);
			return Promise.resolve(new Response(JSON.stringify({ ok: true })));
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const context = createProxyContext([qwen, kimi], accounts, {
			"anthropic-messages": ["qwen-claude", "kimi-claude"],
		});
		const request = (body: string, headers: Record<string, string>) =>
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-agent-smith-interactive-provider-choice": "v1",
						"x-claude-code-session-id": "session-for-choice",
						...headers,
					},
					body,
				},
			);
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);

		await handleProxy(
			request(
				'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"main turn"}]}',
				{ "x-agent-smith-provider-choice": "kimi-claude" },
			),
			url,
			context,
		);
		await handleProxy(
			request(
				'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"title request"}]}',
				{},
			),
			url,
			context,
		);

		expect(urls).toEqual([
			"https://kimi-claude.example.com/v1/messages",
			"https://kimi-claude.example.com/v1/messages",
		]);
	});

	it("reoffers a higher provider only after its reported retry time and stays quiet after a decline", async () => {
		const qwen = createTestProvider("qwen-claude", {
			category: "request-rate",
			retryAt: Date.now() - 1,
		});
		const kimi = createTestProvider("kimi-claude");
		const accounts = [
			{ ...createTestAccount(), id: "qwen-account", provider: "qwen-claude" },
			{ ...createTestAccount(), id: "kimi-account", provider: "kimi-claude" },
		] as Account[];
		globalThis.fetch = mock((url: string) =>
			Promise.resolve(
				url.includes("qwen-claude")
					? new Response("limited", { status: 429 })
					: new Response("ok"),
			),
		) as unknown as typeof fetch;
		const context = createProxyContext([qwen, kimi], accounts, {
			"anthropic-messages": ["qwen-claude", "kimi-claude"],
		});
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);
		const request = (headers: Record<string, string>) =>
			new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-agent-smith-interactive-provider-choice": "v1",
					"x-claude-code-session-id": "promotion-session",
					...headers,
				},
				body: '{"model":"claude-sonnet-4-5","messages":[]}',
			});

		await handleProxy(request({}), url, context);
		await handleProxy(
			request({ "x-agent-smith-provider-choice": "kimi-claude" }),
			url,
			context,
		);
		const response = await handleProxy(request({}), url, context);

		expect(
			response.headers.get("x-agent-smith-provider-promotion-details"),
		).toBeTruthy();
		const declined = await handleProxy(
			request({ "x-agent-smith-provider-promotion-declined": "v1" }),
			url,
			context,
		);
		const later = await handleProxy(request({}), url, context);
		expect(
			declined.headers.get("x-agent-smith-provider-promotion-details"),
		).toBeNull();
		expect(
			later.headers.get("x-agent-smith-provider-promotion-details"),
		).toBeNull();
	});

	it("does not pretend an upstream provider recovered without a retry time", async () => {
		const qwen = createTestProvider("qwen-claude", {
			category: "dynamic-throughput",
		});
		const kimi = createTestProvider("kimi-claude");
		const accounts = [
			{ ...createTestAccount(), id: "qwen-account", provider: "qwen-claude" },
			{ ...createTestAccount(), id: "kimi-account", provider: "kimi-claude" },
		] as Account[];
		globalThis.fetch = mock((url: string) =>
			Promise.resolve(
				url.includes("qwen-claude")
					? new Response("limited", { status: 429 })
					: new Response("ok"),
			),
		) as unknown as typeof fetch;
		const context = createProxyContext([qwen, kimi], accounts, {
			"anthropic-messages": ["qwen-claude", "kimi-claude"],
		});
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);
		const request = (headers: Record<string, string>) =>
			new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-agent-smith-interactive-provider-choice": "v1",
					"x-claude-code-session-id": "unknown-recovery-session",
					...headers,
				},
				body: '{"model":"claude-sonnet-4-5","messages":[]}',
			});

		await handleProxy(request({}), url, context);
		await handleProxy(
			request({ "x-agent-smith-provider-choice": "kimi-claude" }),
			url,
			context,
		);
		const response = await handleProxy(request({}), url, context);

		expect(
			response.headers.get("x-agent-smith-provider-promotion-details"),
		).toBeNull();
	});

	it("holds a selected wait request until the provider retry time", async () => {
		const retryAt = Date.now() + 10_000;
		const qwen = createTestProvider("qwen-claude", {
			category: "request-rate",
			retryAt,
		});
		const account = {
			...createTestAccount(),
			provider: "qwen-claude",
		} as Account;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("limited", { status: 429 })),
		) as unknown as typeof fetch;
		const context = createProxyContext([qwen], [account], {
			"anthropic-messages": ["qwen-claude"],
		});
		const waitUntil = mock(() => Promise.resolve());
		context.quotaHold = { waitUntil } as unknown as NonNullable<
			typeof context.quotaHold
		>;
		context.runtime.teamRouting.holdSeconds = 60;
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);
		const request = (wait = false) =>
			new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-agent-smith-interactive-provider-choice": "v1",
					"x-claude-code-session-id": "wait-session",
					...(wait ? { "x-agent-smith-provider-wait": "v1" } : {}),
				},
				body: '{"model":"claude-sonnet-4-5","messages":[]}',
			});

		await handleProxy(request(), url, context);
		await handleProxy(request(true), url, context);

		expect(waitUntil).toHaveBeenCalledWith(retryAt, expect.any(AbortSignal));
	});

	it("does not retry upstream when the selected wait exceeds the server hold window", async () => {
		const retryAt = Date.now() + 60_000;
		const qwen = createTestProvider("qwen-claude", {
			category: "request-rate",
			retryAt,
		});
		const account = {
			...createTestAccount(),
			provider: "qwen-claude",
		} as Account;
		const fetchMock = mock(() =>
			Promise.resolve(new Response("limited", { status: 429 })),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const context = createProxyContext([qwen], [account], {
			"anthropic-messages": ["qwen-claude"],
		});
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);
		const request = (wait = false) =>
			new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-agent-smith-interactive-provider-choice": "v1",
					"x-claude-code-session-id": "too-long-wait-session",
					...(wait ? { "x-agent-smith-provider-wait": "v1" } : {}),
				},
				body: '{"model":"claude-sonnet-4-5","messages":[]}',
			});

		await handleProxy(request(), url, context);
		const response = await handleProxy(request(true), url, context);

		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({
			blockedProvider: "qwen-claude",
			category: "request-rate",
			wait: { retryAt },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("offers wait only when a blocked request continues an upstream message thread", async () => {
		const qwen = createTestProvider("qwen-claude", {
			category: "request-rate",
		});
		const kimi = createTestProvider("kimi-claude");
		const qwenAccount = {
			...createTestAccount(),
			id: "qwen-account",
			provider: "qwen-claude",
		} as Account;
		const kimiAccount = {
			...createTestAccount(),
			id: "kimi-account",
			provider: "kimi-claude",
		} as Account;
		const fetchMock = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ code: "Throttling.RateQuota" }), {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const context = createProxyContext(
			[qwen, kimi],
			[qwenAccount, kimiAccount],
			{ "anthropic-messages": ["qwen-claude", "kimi-claude"] },
		);
		context.messageThreads = new Map([
			[
				"message-from-qwen",
				{
					accountId: "qwen-account",
					expiresAt: Date.now() + 60_000,
					sessionId: "thread-session",
				},
			],
		]);

		const response = await handleProxy(
			new Request(
				"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-agent-smith-interactive-provider-choice": "v1",
						"x-claude-code-session-id": "thread-session",
					},
					body: '{"model":"claude-sonnet-4-5","thread":{"type":"continue","previous_message_id":"message-from-qwen"},"messages":[]}',
				},
			),
			new URL("http://localhost:8080/v1/pool/anthropic-messages/v1/messages"),
			context,
		);

		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({ choices: [] });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
