import { describe, expect, it } from "bun:test";
import { ProviderRegistry } from "@agent-smith/providers";
import type { ProxyContext } from "@agent-smith/proxy";
import { createServerFetchHandler, createStartupBanner } from "./server";

function createProxyContext(): ProxyContext {
	return {
		providerRegistry: new ProviderRegistry(),
		strategy: {
			select() {
				return [];
			},
		},
		dbOps: {
			getAllAccounts() {
				return [];
			},
			getAccountsByProvider() {
				return [];
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

describe("createServerFetchHandler", () => {
	it("describes multi-provider routing in the startup banner", () => {
		const banner = createStartupBanner({
			version: "1.0.0",
			port: 8080,
			withDashboard: true,
			strategy: "session",
			providers: ["anthropic", "openai"],
		});

		expect(banner).toContain("/v1/{provider}/*");
		expect(banner).toContain("Proxy native provider APIs");
		expect(banner).toContain("Supported providers: anthropic, openai");
		expect(banner).not.toContain("Claude API");
	});

	it("routes provider-prefixed requests to the proxy handler", async () => {
		let proxyCalls = 0;
		const fetchHandler = createServerFetchHandler({
			apiRouter: {
				handleRequest: async () => null,
			},
			proxyContext: createProxyContext(),
			withDashboard: true,
			handleProxyRequest: async () => {
				proxyCalls += 1;
				return new Response("proxied");
			},
			serveDashboardAsset: () => null,
		});

		const response = await fetchHandler(
			new Request("http://localhost:8080/v1/anthropic/v1/messages", {
				method: "POST",
			}),
		);

		if (!response) {
			throw new Error("Expected an HTTP response");
		}

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("proxied");
		expect(proxyCalls).toBe(1);
	});

	it("sends the unprefixed OAuth token endpoint around account routing", async () => {
		let proxyCalls = 0;
		let tokenCalls = 0;
		const fetchHandler = createServerFetchHandler({
			apiRouter: { handleRequest: async () => null },
			proxyContext: createProxyContext(),
			withDashboard: false,
			handleOAuthTokenRequest: async () => {
				tokenCalls += 1;
				return new Response("token response");
			},
			handleProxyRequest: async () => {
				proxyCalls += 1;
				return new Response("proxied");
			},
		});

		const response = await fetchHandler(
			new Request("http://localhost:8080/v1/oauth/token", {
				method: "POST",
			}),
		);

		expect(await response?.text()).toBe("token response");
		expect(tokenCalls).toBe(1);
		expect(proxyCalls).toBe(0);
	});

	it("applies the proxy body cap before forwarding an OAuth token request", async () => {
		let tokenCalls = 0;
		const proxyContext = createProxyContext();
		proxyContext.runtime.maxBodyBytes = 4;
		const fetchHandler = createServerFetchHandler({
			apiRouter: { handleRequest: async () => null },
			proxyContext,
			withDashboard: false,
			handleOAuthTokenRequest: async () => {
				tokenCalls += 1;
				return new Response("token response");
			},
		});

		const response = await fetchHandler(
			new Request("http://localhost:8080/v1/oauth/token", {
				body: "oversized",
				method: "POST",
			}),
		);

		expect(response?.status).toBe(413);
		expect(tokenCalls).toBe(0);
	});

	it("sends /v1/agent-smith paths to the provider proxy, which has no such provider", async () => {
		const proxiedPaths: string[] = [];
		const fetchHandler = createServerFetchHandler({
			apiRouter: {
				handleRequest: async () => null,
			},
			proxyContext: createProxyContext(),
			withDashboard: true,
			handleProxyRequest: async (_req, url) => {
				proxiedPaths.push(url.pathname);
				return new Response("proxied");
			},
			serveDashboardAsset: () => null,
		});

		const response = await fetchHandler(
			new Request(
				"http://localhost:8080/v1/agent-smith/openai/chat/completions",
				{
					method: "POST",
					body: JSON.stringify({ model: "claude-opus-4.1" }),
					headers: { "content-type": "application/json" },
				},
			),
		);

		if (!response) {
			throw new Error("Expected an HTTP response");
		}

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("proxied");
		expect(proxiedPaths).toEqual(["/v1/agent-smith/openai/chat/completions"]);
	});

	it("routes websocket upgrade requests through the websocket upgrader", async () => {
		let proxyCalls = 0;
		let upgradeCalls = 0;
		const fetchHandler = createServerFetchHandler({
			apiRouter: {
				handleRequest: async () => null,
			},
			proxyContext: createProxyContext(),
			withDashboard: true,
			handleProxyRequest: async () => {
				proxyCalls += 1;
				return new Response("proxied");
			},
			handleWebSocketUpgrade: () => {
				upgradeCalls += 1;
				return undefined;
			},
			serveDashboardAsset: () => null,
		});

		const response = await fetchHandler(
			new Request("http://localhost:8080/v1/codex/responses", {
				method: "GET",
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
				},
			}),
			{
				upgrade() {
					return true;
				},
			} as unknown as Bun.Server<unknown>,
		);

		expect(response).toBeUndefined();
		expect(upgradeCalls).toBe(1);
		expect(proxyCalls).toBe(0);
	});

	it("returns 404 for non-v1 proxy-like routes instead of falling back", async () => {
		let proxyCalls = 0;
		let dashboardCalls = 0;
		const fetchHandler = createServerFetchHandler({
			apiRouter: {
				handleRequest: async () => null,
			},
			proxyContext: createProxyContext(),
			withDashboard: true,
			handleProxyRequest: async () => {
				proxyCalls += 1;
				return new Response("proxied");
			},
			serveDashboardAsset: () => {
				dashboardCalls += 1;
				return new Response("dashboard");
			},
		});

		const response = await fetchHandler(
			new Request("http://localhost:8080/v2/messages", {
				method: "POST",
			}),
		);

		if (!response) {
			throw new Error("Expected an HTTP response");
		}

		expect(response.status).toBe(404);
		expect(proxyCalls).toBe(0);
		expect(dashboardCalls).toBe(0);
	});
});
