import { expect, test } from "bun:test";
import type { Provider, ProviderRegistry } from "@ccflare/providers";
import type { Account, AccountQuotaState } from "@ccflare/types";
import { OutsideSpendTracker } from "./outside-spend";
import { QuotaProbe } from "./quota-probe";

const config = {
	enabled: true,
	distributionEnabled: true,
	allowlistedAccountUuids: ["seat"],
	maxUsage: 0.9,
	admissionCap: 1,
	admissionQueueLimit: 1,
	admissionWaitMs: 1,
	holdSeconds: 0,
	quotaProbeSeconds: 1,
};

type ProviderLookup = Pick<ProviderRegistry, "getProvider">;

function providerLookup(provider: Provider): ProviderLookup {
	return { getProvider: () => provider };
}

function probeProvider(quota: AccountQuotaState): Provider {
	return {
		name: "claude-code",
		defaultBaseUrl: "https://provider.example",
		wire: "anthropic-messages",
		buildUrl: () => "https://provider.example",
		prepareHeaders: (headers) => new Headers(headers),
		parseRateLimit: () => ({ isRateLimited: false }),
		quotaBucketsFor: () => undefined,
		weeklyBucketFor: () => "providerWeekly",
		isWeeklyBucket: () => true,
		isFiveHourBucket: () => false,
		supportsQuotaProbe: () => true,
		probeQuota: async () => quota,
		processResponse: async (response) => response,
	};
}

function account(): Account {
	return {
		id: "a",
		name: "a",
		provider: "claude-code",
		auth_method: "oauth",
		base_url: null,
		api_key: null,
		refresh_token: null,
		access_token: "token",
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
		account_uuid: "seat",
	};
}

test("reads only allowlisted direct OAuth seats and persists fresh quota", async () => {
	const a = account();
	const states: AccountQuotaState[] = [];
	const provider = probeProvider({
		windows: {
			unified7d: {
				utilization: 0.2,
				resetAt: 10_000,
				seenAt: 1,
				status: null,
			},
		},
	});
	const probe = new QuotaProbe(
		() => config,
		{
			getAllAccounts: () => [a],
			updateAccountQuotaState: (_id, state) => states.push(state),
		},
		new OutsideSpendTracker(),
		providerLookup(provider),
	);
	probe.start();
	await Promise.resolve();
	await Promise.resolve();
	expect(states).toHaveLength(1);
	expect(states[0]?.windows.unified7d?.utilization).toBe(0.2);
	probe.dispose();
});

test("uses the provider strategy instead of a provider name to select probes", async () => {
	const a = account();
	const states: AccountQuotaState[] = [];
	const provider = probeProvider({
		windows: {
			providerWeekly: {
				utilization: 0.2,
				resetAt: 10_000,
				seenAt: 1,
				status: null,
			},
		},
	});
	const probe = new QuotaProbe(
		() => config,
		{
			getAllAccounts: () => [a],
			updateAccountQuotaState: (_id, state) => states.push(state),
		},
		new OutsideSpendTracker(),
		providerLookup(provider),
	);

	probe.start();
	await Promise.resolve();
	await Promise.resolve();
	expect(states).toHaveLength(1);
	expect(states[0]?.windows.providerWeekly?.utilization).toBe(0.2);
	probe.dispose();
});
