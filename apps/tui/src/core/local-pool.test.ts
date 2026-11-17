import { describe, expect, it } from "bun:test";
import {
	type TeamRoutingConfig,
	WINDOW_WARMUP_DEFAULTS,
} from "@agent-smith/config";
import type { Account } from "@agent-smith/types";
import {
	formatPoolLimits,
	isPoolEligible,
	nextTeamRoutingConfig,
	teamRoutingFileConfig,
} from "./local-pool";

const routing: TeamRoutingConfig = {
	enabled: true,
	distributionEnabled: true,
	preferExpiringQuota: false,
	allowlistedAccountUuids: ["existing-seat"],
	maxUsage: 0.9,
	weeklyMaxUsage: 0.9,
	weeklyMaxUsageByEmail: {},
	admissionCap: 5,
	admissionQueueLimit: 25,
	admissionWaitMs: 30_000,
	holdSeconds: 0,
	quotaProbeSeconds: 0,
	windowWarmup: WINDOW_WARMUP_DEFAULTS,
};

function oauthSeat(overrides: Partial<Account> = {}): Account {
	return {
		id: "account-id",
		name: "dev-seat",
		provider: "claude-code",
		auth_method: "oauth",
		base_url: null,
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
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
		account_uuid: "new-seat",
		...overrides,
	};
}

describe("local pool policy", () => {
	it("adds an explicit Claude Code OAuth seat without weakening existing limits", () => {
		const policy = {
			...routing,
			weeklyMaxUsage: 0.95,
			weeklyMaxUsageByEmail: { "tech@example.test": 0.3 },
		};
		const next = nextTeamRoutingConfig(policy, oauthSeat(), true);

		expect(next).toEqual({
			...policy,
			enabled: true,
			allowlistedAccountUuids: ["existing-seat", "new-seat"],
		});
		expect(teamRoutingFileConfig(next)).toMatchObject({
			allowlisted_account_uuids: ["existing-seat", "new-seat"],
			weekly_max_usage: 0.95,
			weekly_max_usage_by_email: { "tech@example.test": 0.3 },
		});
	});

	it("turns routing off when its final pooled seat is protected", () => {
		const next = nextTeamRoutingConfig(
			{ ...routing, allowlistedAccountUuids: ["new-seat"] },
			oauthSeat(),
			false,
		);

		expect(next).toEqual({
			...routing,
			enabled: false,
			allowlistedAccountUuids: [],
		});
	});

	it("writes the window warm-up schedule back, since a seat toggle replaces the whole policy", () => {
		const windowWarmup = {
			enabled: true,
			times: ["07:30"],
			timeZone: "Europe/London",
			weekdaysOnly: false,
			model: "claude-haiku-4-5",
		};

		expect(
			teamRoutingFileConfig({ ...routing, windowWarmup }).window_warmup,
		).toEqual({
			enabled: true,
			times: ["07:30"],
			time_zone: "Europe/London",
			weekdays_only: false,
			model: "claude-haiku-4-5",
		});
	});

	it("refuses non-OAuth and unidentified accounts", () => {
		expect(isPoolEligible(oauthSeat())).toBe(true);
		expect(isPoolEligible(oauthSeat({ auth_method: "api_key" }))).toBe(false);
		expect(isPoolEligible(oauthSeat({ account_uuid: null }))).toBe(false);
		expect(() =>
			nextTeamRoutingConfig(routing, oauthSeat({ account_uuid: null }), true),
		).toThrow("OAuth seat with a verified account identity");
	});

	it("shows only observed quota windows instead of inventing limits", () => {
		expect(
			formatPoolLimits({
				windows: {
					unified5h: {
						resetAt: null,
						seenAt: 1,
						status: null,
						utilization: 0.43,
					},
					unified7d: {
						resetAt: null,
						seenAt: 1,
						status: null,
						utilization: 0.12,
					},
				},
			}),
		).toBe("5h 43% · 7d 12%");
		expect(formatPoolLimits(null)).toBe("limits not observed yet");
	});
});
