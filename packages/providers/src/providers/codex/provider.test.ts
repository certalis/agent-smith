import { afterEach, describe, expect, it } from "bun:test";
import {
	createJsonFetchMock,
	createOAuthAccount,
	expectBuildUrlCases,
	expectRemovedHeaders,
	originalFetch,
} from "../../test-helpers";
import { CodexProvider } from "./provider";

describe("CodexProvider", () => {
	const provider = new CodexProvider();

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("builds backend-api URLs from the stripped Codex path", () => {
		expectBuildUrlCases(provider, [
			{
				upstreamPath: "/responses",
				expected: "https://chatgpt.com/backend-api/codex/responses",
			},
			{
				upstreamPath: "/responses",
				query: "?stream=true",
				expected: "https://chatgpt.com/backend-api/codex/responses?stream=true",
			},
			{
				upstreamPath: "/tasks",
				account: createOAuthAccount("codex", {
					base_url: "https://chatgpt.internal/backend-api/codex/",
				}),
				expected: "https://chatgpt.internal/backend-api/codex/tasks",
			},
		]);
	});

	it("injects Bearer auth plus Codex headers", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				host: "localhost:8080",
				"x-api-key": "client-supplied-key",
				"anthropic-version": "2023-06-01",
				"accept-encoding": "gzip",
				"content-encoding": "gzip",
			}),
			createOAuthAccount("codex"),
		);

		expect(headers.get("authorization")).toBe("Bearer codex-access-token");
		expect(headers.get("originator")).toBe("codex_cli_rs");
		expect(headers.get("user-agent")).toContain("codex_cli_rs/");
		expect(headers.get("user-agent")).toContain("arm64");
		expectRemovedHeaders(headers, [
			"x-api-key",
			"anthropic-version",
			"host",
			"accept-encoding",
			"content-encoding",
		]);
	});

	it("owns the Codex weekly quota window", () => {
		expect(provider.weeklyBucketFor("gpt-5-codex")).toBe("unified7d");
		expect(provider.isWeeklyBucket("unified7d")).toBe(true);
		expect(provider.isWeeklyBucket("unified7dOpus")).toBe(false);
	});

	it("refreshes OAuth tokens via auth.openai.com with rotating refresh tokens", async () => {
		let requestUrl = "";
		let requestBody = "";

		globalThis.fetch = createJsonFetchMock(
			{
				access_token: "fresh-codex-access-token",
				refresh_token: "fresh-codex-refresh-token",
				expires_in: 1800,
			},
			async (request) => {
				requestUrl = request.url;
				requestBody = await request.text();
			},
		);

		const refreshed = await provider.refreshToken(
			createOAuthAccount("codex"),
			"unused-client-id",
		);

		expect(requestUrl).toBe("https://auth.openai.com/oauth/token");
		expect(requestBody).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
		expect(requestBody).toContain("refresh_token=codex-refresh-token");
		expect(refreshed).toEqual({
			accessToken: "fresh-codex-access-token",
			refreshToken: "fresh-codex-refresh-token",
			expiresAt: expect.any(Number),
		});
	});

	it("normalizes Codex quota windows by their declared duration", () => {
		const fiveHourReset = Math.floor((Date.now() + 60_000) / 1000);
		const sevenDayReset = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"x-codex-5h-reset-at": String(fiveHourReset),
				"x-codex-7d-reset-at": String(sevenDayReset),
				"x-codex-primary-used-percent": "12",
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-reset-at": String(sevenDayReset),
				"x-codex-secondary-used-percent": "4",
				"x-codex-secondary-window-minutes": "300",
				"x-codex-secondary-reset-at": String(fiveHourReset),
			},
		});

		const rateLimit = provider.parseRateLimit(response);

		expect(rateLimit).toMatchObject({
			isRateLimited: false,
			resetTime: fiveHourReset * 1000,
			statusHeader: "allowed",
			quotaState: {
				windows: {
					unified5h: {
						resetAt: fiveHourReset * 1000,
						status: null,
						utilization: 0.04,
					},
					unified7d: {
						resetAt: sevenDayReset * 1000,
						status: null,
						utilization: 0.12,
					},
				},
			},
		});
		expect(rateLimit.quotaState?.windows.unified7dFable).toBeUndefined();
	});

	it("surfaces the Codex active limit without inventing a quota window", () => {
		const rateLimit = provider.parseRateLimit(
			new Response("{}", {
				headers: { "x-codex-active-limit": "premium" },
			}),
		);

		expect(rateLimit).toMatchObject({ activeLimit: "premium" });
		expect(rateLimit.quotaState).toBeUndefined();
	});

	it("does not create a quota window for a zero-length Codex window", () => {
		const rateLimit = provider.parseRateLimit(
			new Response("{}", {
				headers: {
					"x-codex-primary-used-percent": "42",
					"x-codex-primary-window-minutes": "10080",
					"x-codex-secondary-used-percent": "0",
					"x-codex-secondary-window-minutes": "0",
				},
			}),
		);

		expect(rateLimit.quotaState?.windows).toEqual({
			unified7d: {
				resetAt: null,
				seenAt: expect.any(Number),
				status: null,
				utilization: 0.42,
			},
		});
	});

	it("does not create a quota window when the declared duration has no signal", () => {
		const rateLimit = provider.parseRateLimit(
			new Response("{}", {
				headers: { "x-codex-primary-window-minutes": "300" },
			}),
		);

		expect(rateLimit.quotaState).toBeUndefined();
	});

	it("ignores a blank Codex reset-after value", () => {
		const rateLimit = provider.parseRateLimit(
			new Response("{}", {
				headers: {
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-after-seconds": "",
				},
			}),
		);

		expect(rateLimit.quotaState).toBeUndefined();
	});

	it("records a fully used Codex quota without rejecting a successful response", () => {
		const rateLimit = provider.parseRateLimit(
			new Response("{}", {
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-window-minutes": "300",
				},
			}),
		);

		expect(rateLimit.isRateLimited).toBe(false);
		expect(rateLimit.quotaState?.windows.unified5h?.utilization).toBe(1);
	});

	it("keeps an account-wide window when a named model family reports the same duration", () => {
		const resetAt = Math.floor((Date.now() + 60_000) / 1000);
		const rateLimit = provider.parseRateLimit(
			new Response("{}", {
				headers: {
					"x-codex-primary-used-percent": "10",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": String(resetAt),
					"x-codex-bengalfox-primary-used-percent": "99",
					"x-codex-bengalfox-primary-window-minutes": "300",
					"x-codex-bengalfox-primary-reset-at": String(resetAt),
				},
			}),
		);

		expect(rateLimit.quotaState?.windows.unified5h).toMatchObject({
			utilization: 0.1,
			resetAt: resetAt * 1000,
		});
	});
});
