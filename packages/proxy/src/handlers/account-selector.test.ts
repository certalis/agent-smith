import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { Account, AccountProvider, RequestMeta } from "@ccflare/types";
import {
	getSoonestQuotaReset,
	selectAccountsForRequest,
} from "./account-selector";
import type { ResolvedProxyContext } from "./proxy-types";

afterEach(() => setSystemTime());

const quotaProvider = {
	quotaBucketsFor: () => undefined,
	isWeeklyBucket: () => false,
};

function createAccount(
	id: string,
	name: string,
	provider: AccountProvider,
): Account {
	return {
		id,
		name,
		provider,
		auth_method: "api_key",
		base_url: null,
		api_key: null,
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

describe("selectAccountsForRequest", () => {
	it("filters accounts using the resolved provider name", () => {
		const seenProviders: string[][] = [];
		const meta: RequestMeta = {
			id: "request-1",
			method: "POST",
			path: "/v1/openai/responses",
			timestamp: Date.now(),
		};
		const ctx = {
			providerName: "openai",
			provider: quotaProvider,
			runtime: { quotaThreshold: 0.98 },
			strategy: {
				select(accounts: Account[]) {
					seenProviders.push(accounts.map((account) => account.provider));
					return accounts;
				},
			},
			dbOps: {
				getAvailableAccountsByProvider(provider: AccountProvider) {
					return [
						createAccount("a1", "anthropic-account", "anthropic"),
						createAccount("o1", "openai-account", "openai"),
					].filter((account) => account.provider === provider);
				},
			},
		} as unknown as ResolvedProxyContext;

		const selected = selectAccountsForRequest(meta, ctx);

		expect(seenProviders).toEqual([["openai"]]);
		expect(selected.map((account) => account.name)).toEqual(["openai-account"]);
	});

	it("orders new account choices by the lowest persisted priority", () => {
		const meta: RequestMeta = {
			id: "request-priority",
			method: "POST",
			path: "/v1/claude-code/v1/messages",
			timestamp: Date.now(),
		};
		const ctx = {
			providerName: "claude-code",
			provider: quotaProvider,
			runtime: { quotaThreshold: 0.98 },
			strategy: { select: (accounts: Account[]) => accounts },
			dbOps: {
				getAvailableAccountsByProvider() {
					return [
						Object.assign(createAccount("a", "later", "claude-code"), {
							priority: 5,
						}),
						Object.assign(createAccount("b", "sooner", "claude-code"), {
							priority: 1,
						}),
					];
				},
			},
		} as unknown as ResolvedProxyContext;

		expect(
			selectAccountsForRequest(meta, ctx).map((account) => account.name),
		).toEqual(["sooner", "later"]);
	});

	it("reports the reset of a fresh quota window that actually blocks the request", () => {
		const now = 1_700_000_000_000;
		setSystemTime(new Date(now));
		const account = Object.assign(
			createAccount("a", "partly-spent", "claude-code"),
			{
				quota_state: {
					windows: {
						unified5h: {
							resetAt: now + 60_000,
							seenAt: now,
							status: "allowed" as const,
							utilization: 0.2,
						},
						unified7d: {
							resetAt: now + 120_000,
							seenAt: now,
							status: "rejected" as const,
							utilization: null,
						},
					},
				},
			},
		);
		const ctx = {
			providerName: "claude-code",
			provider: quotaProvider,
			runtime: { quotaThreshold: 0.98 },
			dbOps: { getAccountsByProvider: () => [account] },
		} as unknown as ResolvedProxyContext;

		expect(
			getSoonestQuotaReset(
				{
					id: "request-reset",
					method: "POST",
					path: "/v1/claude-code/v1/messages",
					timestamp: now,
					model: "claude-retired",
				},
				ctx,
			),
		).toBe(now + 120_000);
	});

	it("waits for the last of a seat's blocking windows, not the first", () => {
		const now = 1_700_000_000_000;
		setSystemTime(new Date(now));
		const rejectedUntil = (resetAt: number) => ({
			resetAt,
			seenAt: now,
			status: "rejected" as const,
			utilization: null,
		});
		const account = Object.assign(createAccount("a", "spent", "claude-code"), {
			quota_state: {
				windows: {
					unified5h: rejectedUntil(now + 60_000),
					unified7d: rejectedUntil(now + 120_000),
				},
			},
		});
		const ctx = {
			providerName: "claude-code",
			provider: quotaProvider,
			runtime: { quotaThreshold: 0.98 },
			dbOps: { getAccountsByProvider: () => [account] },
		} as unknown as ResolvedProxyContext;

		expect(
			getSoonestQuotaReset(
				{
					id: "request-two-windows",
					method: "POST",
					path: "/v1/claude-code/v1/messages",
					timestamp: now,
				},
				ctx,
			),
		).toBe(now + 120_000);
	});

	it("reconsiders a rejected quota window once its reset is reached", () => {
		const now = 1_700_000_000_000;
		setSystemTime(new Date(now + 1_000));
		const account = Object.assign(createAccount("a", "ready", "claude-code"), {
			auth_method: "oauth" as const,
			account_uuid: "seat",
			quota_state: {
				windows: {
					unified5h: {
						resetAt: now + 1_000,
						seenAt: now,
						status: "rejected",
						utilization: 1,
					},
				},
			},
		});
		const ctx = {
			providerName: "claude-code",
			provider: quotaProvider,
			runtime: {
				quotaThreshold: 0.98,
				teamRouting: {
					enabled: true,
					allowlistedAccountUuids: ["seat"],
					maxUsage: 0.9,
				},
			},
			strategy: { select: (accounts: Account[]) => accounts },
			dbOps: { getAvailableAccountsByProvider: () => [account] },
			teamRouter: { order: (accounts: Account[]) => accounts },
		} as unknown as ResolvedProxyContext;
		expect(
			selectAccountsForRequest(
				{
					id: "after-reset",
					method: "POST",
					path: "/v1/claude-code/v1/messages",
					timestamp: now,
				},
				ctx,
			),
		).toEqual([account]);
	});

	it("keeps a stale pooled quota rejection blocked until its reset", () => {
		const now = 1_700_000_000_000;
		setSystemTime(new Date(now));
		const capped = Object.assign(
			createAccount("capped", "stale-rejection", "claude-code"),
			{
				auth_method: "oauth" as const,
				account_uuid: "capped-seat",
				quota_state: {
					windows: {
						unified5h: {
							resetAt: now + 60_000,
							seenAt: now - 30 * 60_000 - 1,
							status: "rejected" as const,
							utilization: null,
						},
					},
				},
			},
		);
		const available = Object.assign(
			createAccount("available", "fresh-seat", "claude-code"),
			{ auth_method: "oauth" as const, account_uuid: "available-seat" },
		);
		const ctx = {
			providerName: "claude-code",
			provider: quotaProvider,
			runtime: {
				quotaThreshold: 0.98,
				teamRouting: {
					enabled: true,
					allowlistedAccountUuids: ["capped-seat", "available-seat"],
					maxUsage: 0.9,
				},
			},
			strategy: { select: (accounts: Account[]) => accounts },
			dbOps: { getAvailableAccountsByProvider: () => [capped, available] },
			teamRouter: { order: (accounts: Account[]) => accounts },
		} as unknown as ResolvedProxyContext;

		expect(
			selectAccountsForRequest(
				{
					id: "stale-at-cap",
					method: "POST",
					path: "/v1/claude-code/v1/messages",
					timestamp: now,
				},
				ctx,
			).map((account) => account.name),
		).toEqual(["fresh-seat"]);
	});

	it("does not indefinitely block a stale pooled rejection without a reset", () => {
		const now = 1_700_000_000_000;
		setSystemTime(new Date(now));
		const staleUnknownReset = Object.assign(
			createAccount("unknown-reset", "stale-unknown-reset", "claude-code"),
			{
				auth_method: "oauth" as const,
				account_uuid: "unknown-reset-seat",
				quota_state: {
					windows: {
						unified5h: {
							resetAt: null,
							seenAt: now - 30 * 60_000 - 1,
							status: "rejected" as const,
							utilization: null,
						},
					},
				},
			},
		);
		const ctx = {
			providerName: "claude-code",
			provider: quotaProvider,
			runtime: {
				quotaThreshold: 0.98,
				teamRouting: {
					enabled: true,
					allowlistedAccountUuids: ["unknown-reset-seat"],
					maxUsage: 0.9,
				},
			},
			strategy: { select: (accounts: Account[]) => accounts },
			dbOps: { getAvailableAccountsByProvider: () => [staleUnknownReset] },
			teamRouter: { order: (accounts: Account[]) => accounts },
		} as unknown as ResolvedProxyContext;

		expect(
			selectAccountsForRequest(
				{
					id: "stale-unknown-reset",
					method: "POST",
					path: "/v1/claude-code/v1/messages",
					timestamp: now,
				},
				ctx,
			).map((account) => account.name),
		).toEqual(["stale-unknown-reset"]);
	});

	it("uses the resolved provider's quota buckets to filter accounts", () => {
		const now = 1_700_000_000_000;
		setSystemTime(new Date(now));
		const account = Object.assign(createAccount("a", "spent", "claude-code"), {
			quota_state: {
				windows: {
					providerWeekly: {
						resetAt: now + 60_000,
						seenAt: now,
						status: "rejected" as const,
						utilization: null,
					},
				},
			},
		});
		const ctx = {
			providerName: "claude-code",
			provider: { quotaBucketsFor: () => ["providerWeekly"] },
			quotaProbeAt: new Map([["claude-code", now]]),
			runtime: { quotaThreshold: 0.98 },
			strategy: { select: (accounts: Account[]) => accounts },
			dbOps: { getAvailableAccountsByProvider: () => [account] },
		} as unknown as ResolvedProxyContext;

		expect(
			selectAccountsForRequest(
				{
					id: "provider-buckets",
					method: "POST",
					path: "/v1/claude-code/v1/messages",
					timestamp: now,
				},
				ctx,
			),
		).toEqual([]);
	});
});
