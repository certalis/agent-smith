import { describe, expect, it } from "bun:test";
import { CodexProvider } from "@ccflare/providers";
import type { Account } from "@ccflare/types";
import type { ResolvedProxyContext } from "./proxy-types";
import { isQuotaRejection, processProxyResponse } from "./response-processor";

function createAccount(): Account {
	return {
		id: "account-1",
		name: "primary",
		provider: "openai",
		auth_method: "api_key",
		base_url: null,
		api_key: "sk-test",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
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

function createContext(rateLimitInfo: {
	isRateLimited: boolean;
	statusHeader?: string;
	resetTime?: number | null;
	remaining?: number | null;
}) {
	const calls: string[] = [];
	const queued: Array<() => void> = [];
	const ctx = {
		provider: {
			name: "openai",
			defaultBaseUrl: "https://api.openai.com/v1",
			buildUrl() {
				return "https://api.openai.com/v1/chat/completions";
			},
			prepareHeaders(headers: Headers) {
				return new Headers(headers);
			},
			parseRateLimit() {
				return rateLimitInfo;
			},
			async processResponse(response: Response) {
				return response;
			},
		},
		asyncWriter: {
			enqueue(task: () => void) {
				queued.push(task);
			},
		},
		dbOps: {
			updateAccountUsage() {
				calls.push("updateAccountUsage");
			},
			updateAccountRateLimitMeta() {
				calls.push("updateAccountRateLimitMeta");
			},
			markAccountRateLimited() {
				calls.push("markAccountRateLimited");
			},
		},
	} as unknown as ResolvedProxyContext;

	return {
		ctx,
		calls,
		flush() {
			for (const task of queued) {
				task();
			}
		},
	};
}

describe("processProxyResponse", () => {
	it("classifies a Codex usage-limit rejection without consuming its response", async () => {
		const response = new Response(
			JSON.stringify({ error: { type: "usage_limit_reached" } }),
			{
				status: 429,
				headers: {
					"content-type": "application/json",
					"retry-after": "45",
				},
			},
		);

		expect(await isQuotaRejection(response, new CodexProvider())).toBeTrue();
		expect(await response.json()).toEqual({
			error: { type: "usage_limit_reached" },
		});
	});

	it("keeps successful response processing limited to rate-limit metadata updates", () => {
		const account = createAccount();
		const { ctx, calls, flush } = createContext({
			isRateLimited: false,
			statusHeader: "allowed",
			resetTime: 1_710_000_000_000,
			remaining: 17,
		});

		const isRateLimited = processProxyResponse(
			new Response("ok", { status: 200 }),
			account,
			ctx,
		);
		flush();

		expect(isRateLimited).toBe(false);
		expect(calls).toEqual(["updateAccountRateLimitMeta"]);
	});

	it("does not increment account usage when rejecting a rate-limited response", () => {
		const account = createAccount();
		const { ctx, calls, flush } = createContext({
			isRateLimited: true,
			statusHeader: "rate_limited",
			resetTime: 1_710_000_000_000,
			remaining: 0,
		});

		const isRateLimited = processProxyResponse(
			new Response("rate limited", { status: 429 }),
			account,
			ctx,
		);
		flush();

		expect(isRateLimited).toBe(true);
		expect(calls).toEqual([
			"markAccountRateLimited",
			"updateAccountRateLimitMeta",
		]);
	});
});
