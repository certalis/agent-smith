import { describe, expect, it } from "bun:test";
import {
	createApiKeyAccount,
	expectBuildUrlCases,
	expectNoOAuthSupport,
	expectRemovedHeaders,
} from "../../test-helpers";
import { AnthropicProvider } from "./provider";

describe("AnthropicProvider", () => {
	const provider = new AnthropicProvider();

	it("builds upstream URLs from the stripped Anthropic path", () => {
		expectBuildUrlCases(provider, [
			{
				upstreamPath: "/v1/messages",
				expected: "https://api.anthropic.com/v1/messages",
			},
			{
				upstreamPath: "/v1/models",
				query: "?foo=bar&baz=qux",
				expected: "https://api.anthropic.com/v1/models?foo=bar&baz=qux",
			},
			{
				upstreamPath: "/v1/messages",
				account: createApiKeyAccount("anthropic", {
					base_url: "https://anthropic.internal/",
				}),
				expected: "https://anthropic.internal/v1/messages",
			},
		]);
	});

	it("injects x-api-key for API key accounts", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				host: "localhost:8080",
				"accept-encoding": "gzip",
				"content-encoding": "gzip",
			}),
			createApiKeyAccount("anthropic"),
		);

		expect(headers.get("x-api-key")).toBe("sk-ant-test");
		expect(headers.get("authorization")).toBeNull();
		expectRemovedHeaders(headers, [
			"host",
			"accept-encoding",
			"content-encoding",
		]);
	});

	it("ignores OAuth access tokens and does not expose OAuth helpers", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				host: "localhost:8080",
			}),
			createApiKeyAccount("anthropic", {
				auth_method: "oauth",
				api_key: null,
				access_token: "oauth-access-token",
				refresh_token: "oauth-refresh-token",
				expires_at: Date.now() + 60_000,
			}),
		);

		expect(headers.get("authorization")).toBeNull();
		expectRemovedHeaders(headers, ["x-api-key", "host"]);
		expectNoOAuthSupport(provider);
	});

	it("owns Anthropic subscription quota buckets", () => {
		expect(provider.quotaBucketsFor("claude-fable-1")).toEqual([
			"unified",
			"unified5h",
			"unified7d",
			"unified7dFable",
		]);
		expect(provider.weeklyBucketFor("claude-opus-4-5")).toBe("unified7dOpus");
		expect(provider.isWeeklyBucket("unified7dSonnet")).toBe(true);
	});

	it("parses Anthropic unified rate limit headers", () => {
		const resetSeconds = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-status": "allowed",
				"anthropic-ratelimit-unified-reset": String(resetSeconds),
				"anthropic-ratelimit-unified-remaining": "17",
			},
		});

		expect(provider.parseRateLimit(response)).toMatchObject({
			isRateLimited: false,
			resetTime: resetSeconds * 1000,
			statusHeader: "allowed",
			remaining: 17,
			quotaState: {
				windows: {
					unified: {
						resetAt: resetSeconds * 1000,
						status: "allowed",
					},
				},
			},
		});
	});

	it("retains quota windows while treating allowed_warning as available", () => {
		const resetSeconds = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-status": "allowed_warning",
				"anthropic-ratelimit-unified-reset": String(resetSeconds),
				"anthropic-ratelimit-unified-5h-status": "allowed_warning",
				"anthropic-ratelimit-unified-5h-utilization": "0.42",
				"anthropic-ratelimit-unified-5h-reset": String(resetSeconds),
			},
		});

		expect(provider.parseRateLimit(response)).toMatchObject({
			isRateLimited: false,
			quotaState: {
				windows: {
					unified5h: {
						resetAt: resetSeconds * 1000,
						seenAt: expect.any(Number),
						status: "allowed_warning",
						utilization: 0.42,
					},
				},
			},
		});
	});

	it("keeps a family-only rejection out of the shared quota verdict", () => {
		const resetSeconds = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-5h-status": "allowed",
				"anthropic-ratelimit-unified-5h-utilization": "0.01",
				"anthropic-ratelimit-unified-5h-reset": String(resetSeconds),
				"anthropic-ratelimit-unified-7d-status": "allowed",
				"anthropic-ratelimit-unified-7d-utilization": "0.52",
				"anthropic-ratelimit-unified-7d-reset": String(resetSeconds),
				"anthropic-ratelimit-unified-7d_oi-status": "rejected",
				"anthropic-ratelimit-unified-7d_oi-utilization": "1.01",
				"anthropic-ratelimit-unified-7d_oi-reset": String(resetSeconds),
			},
		});

		expect(provider.parseRateLimit(response).quotaState).toMatchObject({
			windows: {
				unified: { status: "allowed" },
				unified7dFable: { status: "rejected" },
			},
		});
	});

	it("records the optional unified quota metadata", () => {
		const resetSeconds = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"anthropic-ratelimit-unified-representative-claim": "claude_max",
				"anthropic-ratelimit-unified-fallback-percentage": "0.25",
				"anthropic-ratelimit-unified-overage-status": "allowed",
				"anthropic-ratelimit-unified-overage-reset": String(resetSeconds),
				"anthropic-ratelimit-unified-overage-utilization": "0.4",
				"anthropic-ratelimit-unified-overage-surpassed-threshold": "true",
			},
		});

		expect(provider.parseRateLimit(response).quotaState).toMatchObject({
			representativeClaim: "claude_max",
			fallbackPercentage: 0.25,
			overage: {
				status: "allowed",
				resetAt: resetSeconds * 1000,
				utilization: 0.4,
				surpassedThreshold: true,
			},
		});
	});
});
