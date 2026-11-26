import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import { POOL_DEFAULTS, type ProviderPoolSettings } from "@agent-smith/config";
import { requestEvents, ServiceUnavailableError } from "@agent-smith/core";
import {
	type PoolContext,
	type ProviderSupply,
	TeamRouter,
} from "@agent-smith/pool";
import {
	ClaudeCodeProvider,
	GoogleGeminiProvider,
	type Provider,
	ProviderRegistry,
} from "@agent-smith/providers";
import { Router } from "@agent-smith/routing";
import type { Account } from "@agent-smith/types";
import { SqliteConversationProviderRoutingStore } from "./conversation-provider-routing-store";
import { createProviderSupplies } from "./provider-supply-factory";
import { handleProxy, type ProxyContext } from "./proxy";

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
	providerRouting: Record<string, readonly string[]> | ProviderRegistry = {},
): ProxyContext & { testPool: PoolContext } {
	const preferences = new Map<
		string,
		{ provider: string; promotionDeclined: boolean; lastSeenAt: number }
	>();
	const providerBlocks = new Map<
		string,
		{ category: string; lastSeenAt: number; retryAt: number | undefined }
	>();
	const fixture = {
		providerRegistry:
			providerRouting instanceof ProviderRegistry
				? providerRouting
				: new ProviderRegistry(providers, {
						providerPools: providerRouting,
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
			clientId: "test-client",
			quotaThreshold: 0.9,
			retry: { attempts: 1, delayMs: 0, backoff: 1 },
			sessionDurationMs: 0,
			port: 8080,
			routing: {
				routes: {},
				apiKeyAccounts: "everyone",
				callers: {},
				holdSeconds: 0,
			},
			providerPools: Object.fromEntries(
				providers.map(({ name }) => [
					name,
					{ ...POOL_DEFAULTS, weeklyMaxUsage: 0.9 },
				]),
			),
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
	const testPool = fixture as unknown as PoolContext;
	const context = {
		...fixture,
		testPool,
		routedProviders: new Map<string, ProviderSupply>(),
	};
	context.router = new Router(
		new SqliteConversationProviderRoutingStore(context.dbOps),
	);
	context.routedProviders = createProviderSupplies(testPool, context);
	return context;
}

/** Translate the old global test setup to equivalent settings for each provider. */
function setPoolPolicy(
	context: ProxyContext,
	updates: Partial<ProviderPoolSettings> & {
		orderedCallers?: string[];
	},
) {
	const { orderedCallers, ...poolSettings } = updates;
	for (const pool of Object.values(context.runtime.providerPools))
		Object.assign(pool, poolSettings);
	if (updates.enabled !== undefined)
		context.runtime.routing.apiKeyAccounts = updates.enabled
			? "chooser_or_fallback"
			: "everyone";
	if (orderedCallers)
		context.runtime.routing.callers = Object.fromEntries(
			orderedCallers.map((name) => [name, { allowFallbacks: true }]),
		);
}

afterEach(() => {
	requestEvents.removeAllListeners("event");
	globalThis.fetch = originalFetch;
	mock.restore();
});

describe("handleProxy routing", () => {
	it("preserves Claude Code server safeguards through a pooled OAuth request", async () => {
		const provider = new ClaudeCodeProvider();
		const account: Account = {
			...createTestAccount(),
			provider: "claude-code",
			auth_method: "oauth",
		};
		const registry = new ProviderRegistry([provider], {
			modelMaps: {
				"claude-code": { "claude-sonnet-5-5": "claude-sonnet-5-5" },
			},
			providerPools: { "anthropic-messages": ["claude-code"] },
		});
		const upstreams: Request[] = [];
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const upstream = new Request(input, init);
				upstreams.push(upstream);
				return Response.json({
					type: "message",
					id: "msg_123",
					model: "claude-sonnet-5-5",
					role: "assistant",
					content: [{ type: "text", text: "Safe response" }],
					stop_reason: "end_turn",
					usage: { input_tokens: 3, output_tokens: 2 },
					safeguard_results: {
						decision: "allow",
						applied: ["server-safeguards-2026-11-01"],
					},
				});
			},
		) as unknown as typeof fetch;
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);

		const response = await handleProxy(
			new Request(url, {
				method: "POST",
				headers: {
					"anthropic-beta": "server-safeguards-2026-11-01",
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
					"x-api-key": "caller-must-not-leak",
				},
				body: JSON.stringify({
					model: "claude-sonnet-5-5",
					max_tokens: 32,
					safeguards: {
						mode: "server",
						policies: ["filesystem-write"],
					},
					messages: [{ role: "user", content: "Say hello" }],
				}),
			}),
			url,
			createProxyContext([provider], [account], registry),
		);

		expect(upstreams).toHaveLength(1);
		expect(upstreams[0]?.headers.get("authorization")).toBe(
			"Bearer test-access-token",
		);
		expect(
			upstreams[0]?.headers
				.get("anthropic-beta")
				?.split(",")
				.map((value) => value.trim()),
		).toEqual(["server-safeguards-2026-11-01", "oauth-2025-04-20"]);
		expect(await upstreams[0]?.json()).toMatchObject({
			safeguards: {
				mode: "server",
				policies: ["filesystem-write"],
			},
		});
		expect(await response.json()).toMatchObject({
			safeguard_results: {
				decision: "allow",
				applied: ["server-safeguards-2026-11-01"],
			},
		});
	});

	it("converts a canonical pooled Messages call at the Google provider edge", async () => {
		const provider = new GoogleGeminiProvider();
		provider.name = "gemini";
		const account: Account = {
			...createTestAccount(),
			provider: "gemini",
			auth_method: "api_key",
			api_key: "google-selected-key",
			access_token: null,
			refresh_token: null,
			expires_at: null,
		};
		const registry = new ProviderRegistry([provider], {
			modelMaps: { gemini: { "claude-sonnet-4-5": "gemini-2.5-flash" } },
			providerPools: { "anthropic-messages": ["gemini"] },
		});
		const upstreams: Request[] = [];
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const upstream = new Request(input, init);
				upstreams.push(upstream);
				return new Response(
					JSON.stringify({
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ text: "Hello from Gemini" }],
								},
								finishReason: "STOP",
							},
						],
						usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		) as unknown as typeof fetch;
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);

		const response = await handleProxy(
			new Request(url, {
				method: "POST",
				headers: {
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
					"x-api-key": "caller-must-not-leak",
				},
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					max_tokens: 32,
					messages: [{ role: "user", content: "Say hello" }],
				}),
			}),
			url,
			createProxyContext([provider], [account], registry),
		);

		expect(upstreams).toHaveLength(1);
		expect(upstreams[0]?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
		);
		expect(upstreams[0]?.headers.get("x-goog-api-key")).toBe(
			"google-selected-key",
		);
		expect(upstreams[0]?.headers.get("x-api-key")).toBeNull();
		expect(upstreams[0]?.headers.get("anthropic-version")).toBeNull();
		expect(await upstreams[0]?.json()).toEqual({
			contents: [{ role: "user", parts: [{ text: "Say hello" }] }],
			generationConfig: { maxOutputTokens: 32 },
		});
		expect(await response.json()).toMatchObject({
			type: "message",
			model: "gemini-2.5-flash",
			content: [{ type: "text", text: "Hello from Gemini" }],
		});
	});

	it("returns a client error without an upstream call for unsupported Gemini input", async () => {
		const provider = new GoogleGeminiProvider();
		provider.name = "gemini";
		const account: Account = {
			...createTestAccount(),
			provider: "gemini",
			auth_method: "api_key",
			api_key: "google-selected-key",
			access_token: null,
			refresh_token: null,
			expires_at: null,
		};
		const registry = new ProviderRegistry([provider], {
			modelMaps: { gemini: { "claude-sonnet-4-5": "gemini-2.5-flash" } },
			providerPools: { "anthropic-messages": ["gemini"] },
		});
		const fetchMock = mock(() => Promise.resolve(new Response("unexpected")));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);

		const response = await handleProxy(
			new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					max_tokens: 32,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "image",
									source: { type: "base64", data: "not-supported" },
								},
							],
						},
					],
				}),
			}),
			url,
			createProxyContext([provider], [account], registry),
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain(
			"does not support Anthropic image content",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("offers the provider chooser for a Google RESOURCE_EXHAUSTED response", async () => {
		const gemini = new GoogleGeminiProvider();
		gemini.name = "gemini";
		const backup = createTestProvider("backup");
		const accounts = [
			{
				...createTestAccount(),
				id: "gemini-account",
				provider: "gemini",
				auth_method: "api_key",
				api_key: "google-selected-key",
				access_token: null,
				refresh_token: null,
				expires_at: null,
			},
			{ ...createTestAccount(), id: "backup-account", provider: "backup" },
		] as Account[];
		const registry = new ProviderRegistry([gemini, backup], {
			modelMaps: { gemini: { "claude-sonnet-4-5": "gemini-2.5-flash" } },
			providerPools: { "anthropic-messages": ["gemini", "backup"] },
		});
		const urls: string[] = [];
		globalThis.fetch = mock((url: string) => {
			urls.push(url);
			return Promise.resolve(
				new Response(
					JSON.stringify({
						error: {
							code: 429,
							message: "Resource has been exhausted (e.g. check quota).",
							status: "RESOURCE_EXHAUSTED",
						},
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				),
			);
		}) as unknown as typeof fetch;
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);

		const response = await handleProxy(
			new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-agent-smith-interactive-provider-choice": "v1",
				},
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					max_tokens: 32,
					messages: [{ role: "user", content: "Say hello" }],
				}),
			}),
			url,
			createProxyContext([gemini, backup], accounts, registry),
		);

		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({
			blockedProvider: "gemini",
			category: "unknown",
			choices: [{ provider: "backup", model: "claude-sonnet-4-5" }],
		});
		expect(urls).toEqual([
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
		]);
	});

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
		setPoolPolicy(context, {
			enabled: true,
			allowlistedAccountUuids: ["qwen-seat"],
			orderedCallers: ["agents-box"],
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

	it("tells the usage worker which named device sent a pooled request", async () => {
		const kimi = createTestProvider("kimi-claude");
		const account = {
			...createTestAccount(),
			id: "kimi-account",
			provider: "kimi-claude",
			auth_method: "api_key",
			api_key: "kimi-api-key",
		} as Account;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("served")),
		) as unknown as typeof fetch;
		const context = createProxyContext([kimi], [account], {
			"anthropic-messages": ["kimi-claude"],
		});
		const messages: unknown[] = [];
		context.usageWorker = {
			postMessage: (message: unknown) => messages.push(message),
		} as unknown as Worker;
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);

		const response = await handleProxy(
			new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: '{"model":"claude-sonnet-4-5","messages":[]}',
			}),
			url,
			context,
			"alice-laptop",
		);

		expect(response.status).toBe(200);
		expect(messages[0]).toMatchObject({
			type: "start",
			callerId: "alice-laptop",
		});
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
		setPoolPolicy(context, {
			enabled: true,
			allowlistedAccountUuids: ["qwen-seat"],
			orderedCallers: ["agents-box"],
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

	describe("an interactive caller choosing an API-key provider", () => {
		function interactivePool(providerChoice?: string) {
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
			setPoolPolicy(context, {
				enabled: true,
				allowlistedAccountUuids: ["qwen-seat"],
				orderedCallers: ["agents-box"],
			});
			const request = (callerId: string, interactive = true) =>
				handleProxy(
					new Request(
						"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
						{
							method: "POST",
							headers: {
								"content-type": "application/json",
								...(interactive && {
									"x-agent-smith-interactive-provider-choice": "v1",
								}),
								...(providerChoice && {
									"x-agent-smith-provider-choice": providerChoice,
								}),
							},
							body: '{"model":"claude-sonnet-4-5","messages":[]}',
						},
					),
					new URL(
						"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
					),
					context,
					callerId,
				);
			return { request, urls };
		}

		for (const callerId of ["agents-box", "laptop-01"]) {
			it(`offers ${callerId} the API-key provider after a block`, async () => {
				const { request } = interactivePool();

				const response = await request(callerId);

				expect(response.status).toBe(429);
				expect(await response.json()).toMatchObject({
					blockedProvider: "qwen-claude",
					choices: [{ provider: "kimi-claude" }],
				});
			});

			it(`serves ${callerId} on the API-key provider it chose`, async () => {
				const { request, urls } = interactivePool("kimi-claude");

				const response = await request(callerId);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe("served by kimi");
				expect(urls).toEqual(["https://kimi-claude.example.com/v1/messages"]);
			});
		}

		it("never moves an unnamed device onto an API-key provider without its choice", async () => {
			const { request, urls } = interactivePool("kimi-claude");

			const response = await request("laptop-01", false);

			expect(response.status).toBe(429);
			expect(urls).toEqual(["https://qwen-claude.example.com/v1/messages"]);
		});
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
		setPoolPolicy(context, {
			enabled: true,
			allowlistedAccountUuids: ["claude-seat"],
			callerWeeklyMaxUsage: { "agents-box": 0.7 },
			orderedCallers: ["agents-box"],
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
		context.runtime.routing.holdSeconds = 60;
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
		context.testPool.messageThreads = new Map([
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

describe("pool pin parser compatibility", () => {
	it("looks up the second provider with the first parser, then rebinds with the serving parser", async () => {
		const first = createTestProvider("first-parser");
		const second = createTestProvider("second-parser");
		second.getConversationOpening = (value: unknown) =>
			typeof value === "object" && value !== null
				? ((value as { alternate?: unknown }).alternate ?? null)
				: null;
		const accounts = [
			{
				...createTestAccount(),
				id: "first-seat",
				provider: "first-parser",
				auth_method: "oauth",
				account_uuid: "first-uuid",
			},
			{
				...createTestAccount(),
				id: "second-seat",
				provider: "second-parser",
				auth_method: "oauth",
				account_uuid: "second-uuid",
			},
		] as Account[];
		const ctx = createProxyContext([first, second], accounts, {
			"anthropic-messages": ["first-parser", "second-parser"],
		});
		setPoolPolicy(ctx, {
			enabled: true,
			allowlistedAccountUuids: ["first-uuid", "second-uuid"],
			callerWeeklyMaxUsage: {},
			orderedCallers: [],
		});
		const pins = new Map([
			[
				"cdd09933e1e8dd79417c5f52f8cf61e5b3c2d122854fdc2c24a60abad3d2516a",
				{ accountId: "second-seat", lastSeenAt: Date.now() },
			],
		]);
		ctx.dbOps = {
			...ctx.dbOps,
			getAccount: (id: string) =>
				accounts.find((account) => account.id === id) ?? null,
			getConversationPin: (key: string) => pins.get(key) ?? null,
			upsertConversationPin: (
				key: string,
				accountId: string,
				lastSeenAt: number,
			) => {
				pins.set(key, { accountId, lastSeenAt });
			},
			deleteExpiredConversationPins: () => undefined,
			countConversationPinsByAccount: () => new Map<string, number>(),
		} as unknown as typeof ctx.dbOps;
		ctx.testPool.dbOps = ctx.dbOps;
		const urls: string[] = [];
		globalThis.fetch = mock((url: string) => {
			urls.push(url);
			return Promise.resolve(Response.json({ ok: true }));
		}) as unknown as typeof fetch;
		const url = new URL(
			"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		);
		const response = await handleProxy(
			new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-claude-code-session-id": "session-1",
				},
				body: '{"model":"claude-opus-4-5","messages":[{"role":"user","content":"hello"}],"alternate":"other"}',
			}),
			url,
			ctx,
		);
		expect(response.status).toBe(200);
		expect(urls).toEqual(["https://second-parser.example.com/v1/messages"]);
		expect(
			pins.get(
				"5a1899acb2f1d6c6bf7b02f467c004530d05edde13f3e7ffa6a87838fd31ce20",
			)?.accountId,
		).toBe("second-seat");
	});
});

it("parses the first provider opening once while building a pool chooser", async () => {
	const first = createTestProvider("first");
	const second = createTestProvider("second");
	let parses = 0;
	first.getConversationOpening = (value: unknown) => {
		parses += 1;
		return (value as { messages?: unknown }).messages ?? null;
	};
	const accounts = [
		{
			...createTestAccount(),
			id: "first-seat",
			provider: "first",
			auth_method: "oauth",
			account_uuid: "first",
		},
		{
			...createTestAccount(),
			id: "second-seat",
			provider: "second",
			auth_method: "oauth",
			account_uuid: "second",
		},
	] as Account[];
	const context = createProxyContext([first, second], accounts, {
		"anthropic-messages": ["first", "second"],
	});
	setPoolPolicy(context, { enabled: true });
	setPoolPolicy(context, { allowlistedAccountUuids: ["first", "second"] });
	Object.assign(context.dbOps, {
		deleteExpiredConversationPins() {},
		getConversationPin() {
			return null;
		},
		countConversationPinsByAccount() {
			return new Map();
		},
		upsertConversationPin() {},
		getAccount() {
			return null;
		},
	});
	const url = new URL(
		"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
	);
	const response = await handleProxy(
		new Request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-agent-smith-interactive-provider-choice": "v1",
				"x-agent-smith-provider-menu": "v1",
				"x-claude-code-session-id": "session",
			},
			body: '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hello"}]}',
		}),
		url,
		context,
	);
	expect(response.status).toBe(409);
	expect(parses).toBe(1);
});

it("reuses the first opening digest when an interactive wait retries", async () => {
	const retryAt = Date.now() + 10_000;
	const provider = createTestProvider("qwen-claude", {
		category: "request-rate",
		retryAt,
	});
	let parses = 0;
	let lookups = 0;
	let cleanups = 0;
	provider.getConversationOpening = (value: unknown) => {
		parses += 1;
		return (value as { messages?: unknown }).messages ?? null;
	};
	const seat = {
		...createTestAccount(),
		provider: "qwen-claude",
		auth_method: "oauth",
		account_uuid: "seat",
	} as Account;
	const ctx = createProxyContext([provider], [seat], {
		"anthropic-messages": ["qwen-claude"],
	});
	setPoolPolicy(ctx, { enabled: true });
	setPoolPolicy(ctx, { allowlistedAccountUuids: ["seat"] });
	Object.assign(ctx.dbOps, {
		deleteExpiredConversationPins() {
			cleanups += 1;
		},
		getConversationPin() {
			lookups += 1;
			return null;
		},
		countConversationPinsByAccount() {
			return new Map();
		},
		upsertConversationPin() {},
		getAccount() {
			return null;
		},
	});
	ctx.quotaHold = { waitUntil: async () => {} } as unknown as NonNullable<
		typeof ctx.quotaHold
	>;
	ctx.runtime.routing.holdSeconds = 60;
	globalThis.fetch = mock(() =>
		Promise.resolve(new Response("limited", { status: 429 })),
	) as unknown as typeof fetch;
	const url = new URL(
		"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
	);
	const request = (wait: boolean) =>
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
	await handleProxy(request(false), url, ctx);
	parses = 0;
	lookups = 0;
	cleanups = 0;
	await handleProxy(request(true), url, ctx);
	expect(parses).toBe(1);
	expect(lookups).toBe(1);
	expect(cleanups).toBe(1);
});

it.each([
	["direct", false, "session"],
	["pool", false, "session"],
	["direct", true, null],
	["pool", true, null],
] as const)("does not parse an opening for %s when routing or the session is absent", async (route, enabled, sessionId) => {
	const provider = createTestProvider("first");
	let parses = 0;
	provider.getConversationOpening = () => {
		parses += 1;
		return "opening";
	};
	const seat = {
		...createTestAccount(),
		provider: "first",
		auth_method: "oauth",
		account_uuid: "seat",
	} as Account;
	const ctx = createProxyContext([provider], [seat], {
		"anthropic-messages": ["first"],
	});
	setPoolPolicy(ctx, { enabled: enabled });
	setPoolPolicy(ctx, { allowlistedAccountUuids: ["seat"] });
	Object.assign(ctx.dbOps, {
		deleteExpiredConversationPins() {},
		getConversationPin() {
			return null;
		},
		countConversationPinsByAccount() {
			return new Map();
		},
		upsertConversationPin() {},
	});
	globalThis.fetch = mock(() =>
		Promise.resolve(Response.json({ ok: true })),
	) as unknown as typeof fetch;
	const path =
		route === "direct"
			? "/v1/first/v1/messages"
			: "/v1/pool/anthropic-messages/v1/messages";
	const url = new URL(`http://localhost:8080${path}`);
	const response = await handleProxy(
		new Request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(sessionId ? { "x-claude-code-session-id": sessionId } : {}),
			},
			body: '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hello"}]}',
		}),
		url,
		ctx,
	);
	expect(response.status).toBe(200);
	expect(parses).toBe(0);
});

it("looks up and cleans a pooled seat pin once across chooser checks", async () => {
	const first = createTestProvider("first", { category: "request-rate" });
	const second = createTestProvider("second");
	const accounts = [
		{
			...createTestAccount(),
			id: "first-seat",
			name: "first-seat",
			provider: "first",
			auth_method: "oauth",
			account_uuid: "first",
		},
		{
			...createTestAccount(),
			id: "second-seat",
			name: "second-seat",
			provider: "second",
			auth_method: "oauth",
			account_uuid: "second",
		},
	] as Account[];
	const ctx = createProxyContext([first, second], accounts, {
		"anthropic-messages": ["first", "second"],
	});
	setPoolPolicy(ctx, { enabled: true });
	setPoolPolicy(ctx, { allowlistedAccountUuids: ["first", "second"] });
	let cleanups = 0;
	let lookups = 0;
	Object.assign(ctx.dbOps, {
		deleteExpiredConversationPins() {
			cleanups += 1;
		},
		getConversationPin() {
			lookups += 1;
			return { accountId: "first-seat", lastSeenAt: Date.now() };
		},
		getAccount(id: string) {
			return accounts.find((account) => account.id === id) ?? null;
		},
		countConversationPinsByAccount() {
			return new Map();
		},
		upsertConversationPin() {},
	});
	globalThis.fetch = mock(() =>
		Promise.resolve(new Response("limited", { status: 429 })),
	) as unknown as typeof fetch;
	const url = new URL(
		"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
	);
	const response = await handleProxy(
		new Request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-agent-smith-interactive-provider-choice": "v1",
				"x-claude-code-session-id": "session",
			},
			body: '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hello"}]}',
		}),
		url,
		ctx,
	);
	expect(response.status).toBe(429);
	expect(await response.json()).toMatchObject({
		blockedProvider: "first",
		choices: expect.arrayContaining([
			expect.objectContaining({ provider: "second" }),
		]),
	});
	expect(lookups).toBe(1);
	expect(cleanups).toBe(1);
});

it("cleans a direct seat pin once when selecting an account", async () => {
	const provider = createTestProvider("first");
	const seat = {
		...createTestAccount(),
		id: "seat",
		provider: "first",
		auth_method: "oauth",
		account_uuid: "seat",
	} as Account;
	const ctx = createProxyContext([provider], [seat]);
	setPoolPolicy(ctx, { enabled: true });
	setPoolPolicy(ctx, { allowlistedAccountUuids: ["seat"] });
	let cleanups = 0;
	let lookups = 0;
	Object.assign(ctx.dbOps, {
		deleteExpiredConversationPins() {
			cleanups += 1;
		},
		getConversationPin() {
			lookups += 1;
			return { accountId: "seat", lastSeenAt: Date.now() };
		},
		countConversationPinsByAccount() {
			return new Map();
		},
		upsertConversationPin() {},
	});
	globalThis.fetch = mock(() =>
		Promise.resolve(Response.json({ ok: true })),
	) as unknown as typeof fetch;
	const url = new URL("http://localhost:8080/v1/first/v1/messages");
	const response = await handleProxy(
		new Request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-claude-code-session-id": "session",
			},
			body: '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hello"}]}',
		}),
		url,
		ctx,
	);
	expect(response.status).toBe(200);
	expect(lookups).toBe(1);
	expect(cleanups).toBe(1);
});

it("does not offer an empty provider in the interactive chooser", async () => {
	const first = createTestProvider("first", { category: "request-rate" });
	const empty = createTestProvider("empty");
	const account = { ...createTestAccount(), provider: "first" } as Account;
	const ctx = createProxyContext([first, empty], [account], {
		"anthropic-messages": ["first", "empty"],
	});
	globalThis.fetch = mock(() =>
		Promise.resolve(new Response("limited", { status: 429 })),
	) as unknown as typeof fetch;
	const url = new URL(
		"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
	);
	const response = await handleProxy(
		new Request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-agent-smith-interactive-provider-choice": "v1",
			},
			body: '{"model":"claude-sonnet-4-5","messages":[]}',
		}),
		url,
		ctx,
	);
	expect(response.status).toBe(429);
	expect(((await response.json()) as { choices: unknown[] }).choices).toEqual(
		[],
	);
});

it("logs the original direct manual-pin request path", async () => {
	const { logBus } = await import("@agent-smith/logger");
	const provider = createTestProvider("first");
	const account = {
		...createTestAccount(),
		name: "seat",
		provider: "first",
	} as Account;
	const ctx = createProxyContext([provider], [account]);
	Object.assign(ctx.dbOps, {
		getAccountByName: (name: string) => (name === "seat" ? account : null),
	});
	globalThis.fetch = mock(() =>
		Promise.resolve(new Response("ok")),
	) as unknown as typeof fetch;
	const url = new URL(
		"http://localhost:8080/tc-acct/seat/v1/first/v1/messages",
	);
	const logs: string[] = [];
	const onLog = (event: { msg: string }) => logs.push(event.msg);
	logBus.on("log", onLog);
	try {
		const response = await handleProxy(
			new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: '{"model":"claude-sonnet-4-5","messages":[]}',
			}),
			url,
			ctx,
		);
		expect(response.status).toBe(200);
		expect(logs).toContain("Request: POST /tc-acct/seat/v1/first/v1/messages");
	} finally {
		logBus.off("log", onLog);
	}
});

it("parses the thread body once across pooled providers", async () => {
	const first = createTestProvider("first");
	const second = createTestProvider("second");
	const accounts = [
		{ ...createTestAccount(), provider: "first" },
		{ ...createTestAccount(), id: "seat-two", provider: "second" },
	] as Account[];
	const ctx = createProxyContext([first, second], accounts, {
		"anthropic-messages": ["first", "second"],
	});
	globalThis.fetch = mock(() =>
		Promise.resolve(new Response("ok")),
	) as unknown as typeof fetch;
	const url = new URL(
		"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
	);
	const body = '{"model":"claude-sonnet-4-5","messages":[]}';
	const original = JSON.parse;
	let count = 0;
	JSON.parse = ((
		text: string,
		reviver?: (this: unknown, key: string, value: unknown) => unknown,
	) => {
		if (text === body) count++;
		return original(text, reviver);
	}) as typeof JSON.parse;
	try {
		const response = await handleProxy(
			new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-claude-code-session-id": "session",
				},
				body,
			}),
			url,
			ctx,
		);
		expect(response.status).toBe(200);
		// Model read, one shared thread parse, and the existing body rewrite.
		expect(count).toBe(3);
	} finally {
		JSON.parse = original;
	}
});

it("the provider honors the Router's API-key reach on a direct route", async () => {
	const provider = createTestProvider("first");
	const key = {
		...createTestAccount(),
		provider: "first",
		auth_method: "api_key",
		api_key: "synthetic",
	} as Account;
	const ctx = createProxyContext([provider], [key]);
	setPoolPolicy(ctx, {
		enabled: true,
		allowlistedAccountUuids: [],
	});
	Object.assign(ctx.dbOps, { deleteExpiredConversationPins() {} });
	globalThis.fetch = mock(() =>
		Promise.resolve(new Response("ok")),
	) as unknown as typeof fetch;
	const url = new URL("http://localhost:8080/v1/first/v1/messages");
	const route = {
		scope: { kind: "direct" as const, provider: "first" },
		edge: {
			url,
			method: "POST",
			headers: new Headers({ "content-type": "application/json" }),
			body: new TextEncoder().encode('{"model":"model","messages":[]}').buffer,
			meta: {
				id: "r",
				method: "POST" as const,
				path: url.pathname,
				timestamp: Date.now(),
			},
		},
		model: "model",
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: true,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	};
	const supply = ctx.routedProviders.get("first");
	if (!supply) throw new Error("missing provider");
	expect((await supply.serve(route)).kind).toBe("final");
	expect((await supply.serve({ ...route, apiKeyAccounts: false })).kind).toBe(
		"exhausted",
	);
});

it("ordered fallback starts at the first provider when a saved pin belongs to a removed provider", async () => {
	const first = createTestProvider("first");
	const second = createTestProvider("second");
	const accounts = [
		{
			...createTestAccount(),
			id: "one",
			provider: "first",
			auth_method: "oauth",
			account_uuid: "one",
		},
		{
			...createTestAccount(),
			id: "two",
			provider: "second",
			auth_method: "oauth",
			account_uuid: "two",
		},
		{
			...createTestAccount(),
			id: "old",
			provider: "removed",
			auth_method: "oauth",
			account_uuid: "old",
		},
	] as Account[];
	const ctx = createProxyContext([first, second], accounts, {
		"anthropic-messages": ["first", "second"],
	});
	setPoolPolicy(ctx, {
		enabled: true,
		allowlistedAccountUuids: ["one", "two", "old"],
		orderedCallers: ["box"],
	});
	Object.assign(ctx.dbOps, {
		deleteExpiredConversationPins() {},
		getConversationPin() {
			return { accountId: "old", lastSeenAt: Date.now() };
		},
		getAccount(id: string) {
			return accounts.find((account) => account.id === id) ?? null;
		},
		getConversationProviderPreference() {
			return {
				provider: "second",
				promotionDeclined: false,
				lastSeenAt: Date.now(),
			};
		},
		deleteConversationProviderBlock() {},
		upsertConversationPin() {},
	});
	const seen: string[] = [];
	globalThis.fetch = mock((url: string) => {
		seen.push(url);
		return Promise.resolve(new Response("ok"));
	}) as unknown as typeof fetch;
	const url = new URL(
		"http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
	);
	const response = await handleProxy(
		new Request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-claude-code-session-id": "session",
			},
			body: '{"model":"claude-sonnet-4-5","messages":[]}',
		}),
		url,
		ctx,
		"box",
	);
	expect(response.status).toBe(200);
	expect(seen).toEqual(["https://first.example.com/v1/messages"]);
});

it("finds a pinned provider once without scanning provider seats", async () => {
	const first = createTestProvider("first");
	const second = createTestProvider("second");
	const seat = {
		...createTestAccount(),
		id: "pinned",
		provider: "second",
		auth_method: "oauth",
		account_uuid: "seat",
	} as Account;
	const ctx = createProxyContext([first, second], [seat], {
		"anthropic-messages": ["first", "second"],
	});
	setPoolPolicy(ctx, { enabled: true });
	setPoolPolicy(ctx, { allowlistedAccountUuids: ["seat"] });
	let reads = 0;
	Object.assign(ctx.dbOps, {
		deleteExpiredConversationPins() {},
		getConversationPin: () => ({ accountId: "pinned", lastSeenAt: Date.now() }),
		getAccount: () => {
			reads++;
			return seat;
		},
		getAccountsByProvider: () => {
			throw new Error("unexpected seat scan");
		},
		getAvailableAccountsByProvider: () => {
			throw new Error("unexpected seat scan");
		},
	});
	const url = new URL(
		"http://localhost/v1/pool/anthropic-messages/v1/messages",
	);
	const route = {
		scope: { kind: "pool-route" as const, wire: "anthropic-messages" as const },
		edge: {
			method: "POST",
			url,
			headers: new Headers(),
			body: null,
			meta: {
				id: "r",
				method: "POST" as const,
				path: url.pathname,
				timestamp: 0,
			},
		},
		sessionId: "session",
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	};
	const candidates = [
		ctx.routedProviders.get("first"),
		ctx.routedProviders.get("second"),
	];
	if (!candidates[0] || !candidates[1]) throw new Error("missing providers");
	const states = await Promise.all(
		candidates.map((provider) => provider?.conversationAffinity(route)),
	);
	expect(states.map((state) => state?.holdsConversation)).toEqual([
		false,
		true,
	]);
	expect(reads).toBe(1);
});

it("reuses the Router held by the proxy context for every request", async () => {
	const provider = createTestProvider("first");
	const seat = { ...createTestAccount(), provider: "first" } as Account;
	const ctx = createProxyContext([provider], [seat]);
	let calls = 0;
	Object.assign(ctx, {
		router: {
			route: async () => {
				calls++;
				return new Response("shared router");
			},
		},
	});
	globalThis.fetch = mock(() =>
		Promise.resolve(new Response("unexpected upstream")),
	) as unknown as typeof fetch;
	const url = new URL("http://localhost/v1/first/v1/messages");
	for (let i = 0; i < 2; i++) {
		const response = await handleProxy(
			new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: '{"messages":[]}',
			}),
			url,
			ctx,
		);
		expect(await response.text()).toBe("shared router");
	}
	expect(calls).toBe(2);
});
