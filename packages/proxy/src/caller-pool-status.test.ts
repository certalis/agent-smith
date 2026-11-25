import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { RoutedProvider, RouteRequest } from "@agent-smith/capacity";
import { POOL_DEFAULTS, runtimeForProvider } from "@agent-smith/config";
import { getProviderCallerStatus, type PoolContext } from "@agent-smith/pool";
import { getCallerPoolStatus } from "@agent-smith/routing";
import type { Account, AccountProvider } from "@agent-smith/types";

afterEach(() => setSystemTime());
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

describe("getCallerPoolStatus", () => {
	const now = 1_700_000_000_000;
	const weeklyReset = now + 3_600_000;
	const claude = {
		name: "claude-code",
		quotaBucketsFor: () => undefined,
		isWeeklyBucket: (bucket: string) => bucket === "unified7d",
	};
	const qwen = {
		name: "qwen-claude",
		quotaBucketsFor: () => undefined,
		isWeeklyBucket: () => false,
	};
	const seat = (name: string, weeklyUtilization: number): Account =>
		Object.assign(createAccount(name, name, "claude-code"), {
			auth_method: "oauth" as const,
			account_uuid: name,
			quota_state: {
				windows: {
					unified7d: {
						resetAt: weeklyReset,
						seenAt: now,
						status: "allowed" as const,
						utilization: weeklyUtilization,
					},
				},
			},
		});
	const qwenKey = (name: string, overrides: Partial<Account> = {}): Account =>
		Object.assign(createAccount(name, name, "qwen-claude"), overrides);

	async function statusFor(callerId: string, accounts: Account[]) {
		setSystemTime(new Date(now));
		const ctx = {
			runtime: {
				quotaThreshold: 0.98,
				routing: {
					routes: {},
					apiKeyAccounts: "chooser_or_fallback",
					callers: { box: { allowFallbacks: true } },
					holdSeconds: 0,
				},
				providerPools: Object.fromEntries(
					["claude-code", "qwen-claude"].map((name) => [
						name,
						{
							...POOL_DEFAULTS,
							enabled: true,
							allowlistedAccountUuids: ["seat-a"],
							maxUsage: 0.9,
							weeklyMaxUsage: 0.95,
							weeklyMaxUsageByEmail: {},
							callerWeeklyMaxUsage: { box: 0.7 },
							admissionWaitMs: 1000,
						},
					]),
				),
			},
			providerRegistry: {
				getProvider: (name: string) => (name === "claude-code" ? claude : qwen),
				poolCapacityMembers: () => [
					{ provider: claude, model: undefined },
					{ provider: qwen, model: undefined },
				],
			},
			dbOps: {
				getAccountsByProvider: (provider: AccountProvider) =>
					accounts.filter((account) => account.provider === provider),
				getEnrollmentContact: () => undefined,
			},
		} as unknown as Pick<PoolContext, "runtime" | "dbOps" | "providerRegistry">;
		const route = {
			scope: { kind: "pool-route", wire: "anthropic-messages" },
			callerId,
		} as RouteRequest;
		const providers = [claude, qwen].map((provider) => ({
			name: provider.name,
			status: async (request: RouteRequest) =>
				getProviderCallerStatus(
					provider.name,
					undefined,
					callerId,
					{ ...ctx, runtime: runtimeForProvider(ctx.runtime, provider.name) },
					request.apiKeyAccounts,
				),
		})) as unknown as RoutedProvider[];
		return getCallerPoolStatus({
			route,
			providers,
			orderedFallback:
				ctx.runtime.routing.callers[callerId]?.allowFallbacks === true,
			apiKeyAccounts:
				ctx.runtime.routing.callers[callerId]?.allowFallbacks === true,
			holdSeconds: 0,
		});
	}

	const exhaustedSeatAndQwenKeys = () => [
		seat("seat-a", 0.96),
		qwenKey("qwen-ready"),
		qwenKey("qwen-paused", { paused: true }),
		qwenKey("qwen-cooling", { rate_limited_until: now + 60_000 }),
	];

	it("counts a ready API-key account behind exhausted seats for an ordered-fallback caller", async () => {
		expect(await statusFor("box", exhaustedSeatAndQwenKeys())).toEqual({
			version: 1,
			pool: "anthropic-messages",
			provider: "claude-code",
			routingEnabled: true,
			eligibleAccounts: 1,
			retryAtMs: null,
			holdSeconds: 0,
			admissionWaitMs: 1000,
		});
	});

	it("keeps a caller without the fallback policy on the first provider", async () => {
		expect(await statusFor("laptop", exhaustedSeatAndQwenKeys())).toMatchObject(
			{
				eligibleAccounts: 0,
				retryAtMs: weeklyReset,
			},
		);
	});

	it("excludes a seat above the caller's weekly ceiling only for that caller", async () => {
		const accounts = [seat("seat-a", 0.8)];

		expect(await statusFor("box", accounts)).toMatchObject({
			eligibleAccounts: 0,
			retryAtMs: weeklyReset,
		});
		expect(await statusFor("laptop", accounts)).toMatchObject({
			eligibleAccounts: 1,
		});
	});
});
