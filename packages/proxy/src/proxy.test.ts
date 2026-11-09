import { afterEach, describe, expect, it, mock } from "bun:test";
import { requestEvents, ServiceUnavailableError } from "@agent-smith/core";
import { type Provider, ProviderRegistry } from "@agent-smith/providers";
import type { Account } from "@agent-smith/types";
import { handleProxy, type ProxyContext } from "./proxy";

const originalFetch = globalThis.fetch;

function createTestProvider(name: string): Provider {
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
): ProxyContext {
	return {
		providerRegistry: new ProviderRegistry(providers),
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
				allowlistedAccountUuids: [],
				maxUsage: 0.9,
				admissionCap: 5,
				admissionQueueLimit: 25,
				admissionWaitMs: 30_000,
				holdSeconds: 0,
				quotaProbeSeconds: 0,
			},
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
});
