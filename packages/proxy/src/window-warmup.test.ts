import { expect, test } from "bun:test";
import {
	type RuntimeConfig,
	type TeamRoutingConfig,
	WINDOW_WARMUP_DEFAULTS,
} from "@agent-smith/config";
import type { Provider } from "@agent-smith/providers";
import type { Account, AccountQuotaState } from "@agent-smith/types";
import { OutsideSpendTracker } from "./outside-spend";
import { WindowWarmup } from "./window-warmup";

const NOW = Date.parse("2026-03-27T05:00:00Z");
const HOUR = 3_600_000;

const routing: TeamRoutingConfig = {
	enabled: true,
	distributionEnabled: true,
	preferExpiringQuota: false,
	allowlistedAccountUuids: [
		"idle",
		"running",
		"paused",
		"full",
		"failing",
		"relayed",
		"cooling",
	],
	maxUsage: 0.9,
	weeklyMaxUsage: 0.9,
	weeklyMaxUsageByEmail: {},
	admissionCap: 1,
	admissionQueueLimit: 1,
	admissionWaitMs: 1,
	holdSeconds: 0,
	quotaProbeSeconds: 0,
	windowWarmup: { ...WINDOW_WARMUP_DEFAULTS, enabled: true },
};

function window(utilization: number, resetAt: number | null) {
	return { utilization, resetAt, seenAt: NOW - HOUR, status: null };
}

function seat(name: string, overrides: Partial<Account> = {}): Account {
	return {
		id: name,
		name,
		provider: "claude-code",
		auth_method: "oauth",
		base_url: null,
		api_key: null,
		refresh_token: null,
		access_token: `tok-${name}`,
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
		account_uuid: name,
		...overrides,
	};
}

function warmupProvider(sent: string[]): Provider {
	return {
		name: "claude-code",
		defaultBaseUrl: "https://provider.example",
		wire: "anthropic-messages",
		buildUrl: () => "https://provider.example",
		prepareHeaders: (headers) => new Headers(headers),
		parseRateLimit: () => ({ isRateLimited: false }),
		quotaBucketsFor: () => ["unified5h", "unified7d"],
		weeklyBucketFor: () => "unified7d",
		isWeeklyBucket: (bucket) => bucket === "unified7d",
		isFiveHourBucket: (bucket) => bucket === "unified5h",
		supportsQuotaProbe: (account) => account.base_url === null,
		probeQuota: async () => null,
		startQuotaWindow: async (_account, accessToken) => {
			sent.push(accessToken);
			if (accessToken === "tok-failing") throw new Error("HTTP 401");
			return { windows: { unified5h: window(0.01, NOW + 5 * HOUR) } };
		},
		processResponse: async (response) => response,
	};
}

function warmup(accounts: Account[], config = routing, now = () => NOW) {
	const sent: string[] = [];
	const stored = new Map<string, AccountQuotaState>();
	const runtime: Pick<RuntimeConfig, "quotaThreshold" | "teamRouting"> = {
		quotaThreshold: 0.98,
		teamRouting: config,
	};
	const provider = warmupProvider(sent);
	const subject = new WindowWarmup(
		() => runtime,
		{
			getAllAccounts: () => accounts,
			updateAccountQuotaState: (id, state) => stored.set(id, state),
			getEnrollmentContact: () => null,
		},
		new OutsideSpendTracker(() => NOW),
		{ getProvider: () => provider },
		async (account) => account.access_token,
		now,
	);
	return { sent, stored, subject };
}

const fleet = () => [
	seat("idle", {
		quota_state: { windows: { unified5h: window(0.4, NOW - HOUR) } },
	}),
	seat("running", {
		quota_state: { windows: { unified5h: window(0.1, NOW + HOUR) } },
	}),
	seat("paused", { paused: true }),
	seat("protected", { account_uuid: "not-allowlisted" }),
	seat("full", {
		quota_state: { windows: { unified7d: window(0.95, NOW + 48 * HOUR) } },
	}),
	seat("failing"),
	seat("relayed", { base_url: "https://relay.example" }),
	seat("cooling", { rate_limited_until: NOW + HOUR }),
];

test("sends one request per idle, direct, allowlisted, unpaused, uncooled seat under its cap", async () => {
	const { sent, stored, subject } = warmup(fleet());

	await subject.run();

	expect(sent.sort()).toEqual(["tok-failing", "tok-idle"]);
	expect([...stored.keys()]).toEqual(["idle"]);
	expect(stored.get("idle")?.windows.unified5h?.resetAt).toBe(NOW + 5 * HOUR);
});

test("fires once at 06:00 Paris, then waits for the next scheduled time", async () => {
	let clock = NOW - 1;
	const { sent, subject } = warmup(fleet(), routing, () => clock);

	subject.start();
	clock = NOW;
	await Bun.sleep(20);
	subject.dispose();

	expect(sent.sort()).toEqual(["tok-failing", "tok-idle"]);
});

test("sends nothing while the warm-up is off", async () => {
	const { sent, subject } = warmup(fleet(), {
		...routing,
		windowWarmup: WINDOW_WARMUP_DEFAULTS,
	});

	await subject.run();

	expect(sent).toEqual([]);
});
