import { describe, expect, it } from "bun:test";
import { AnthropicProvider } from "@agent-smith/providers";
import type { Account, QuotaWindow } from "@agent-smith/types";
import { compareSeatUsage } from "./seat-usage";

const now = 1_700_000_000_000;
const hour = 60 * 60 * 1_000;
const provider = new AnthropicProvider();

const window = (resetAt: number, utilization: number): QuotaWindow => ({
	resetAt,
	seenAt: now,
	status: "allowed",
	utilization,
});

const onPaceWeek = window(now + 6 * 24 * hour, 0.05);
const aheadOfPaceWeek = window(now + 6 * 24 * hour, 0.5);

function seat(name: string, windows: Record<string, QuotaWindow>): Account {
	return {
		id: name,
		name,
		provider: "claude-code",
		auth_method: "oauth",
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
		quota_state: { windows },
	};
}

const order = (seats: Account[], model = "claude-opus-4-5") =>
	[...seats]
		.sort(compareSeatUsage(provider, model, now))
		.map((account) => account.name);

describe("compareSeatUsage", () => {
	it("puts the lowest five-hour usage first among seats on their weekly pace", () => {
		expect(
			order([
				seat("busy", {
					unified5h: window(now + hour, 0.6),
					unified7d: onPaceWeek,
				}),
				seat("quiet", {
					unified5h: window(now + hour, 0.2),
					unified7d: onPaceWeek,
				}),
			]),
		).toEqual(["quiet", "busy"]);
	});

	it("puts lower five-hour usage first when both seats remain below the weekly cap", () => {
		expect(
			order([
				seat("ahead", {
					unified5h: window(now + hour, 0.05),
					unified7d: aheadOfPaceWeek,
				}),
				seat("on-pace", {
					unified5h: window(now + hour, 0.6),
					unified7d: onPaceWeek,
				}),
			]),
		).toEqual(["ahead", "on-pace"]);
	});

	it("counts a five-hour window whose reset has passed as unused", () => {
		expect(
			order([
				seat("live", {
					unified5h: window(now + hour, 0.3),
					unified7d: onPaceWeek,
				}),
				seat("reset", {
					unified5h: window(now - 1, 0.8),
					unified7d: onPaceWeek,
				}),
			]),
		).toEqual(["reset", "live"]);
	});

	it("uses a family weekly bucket only for that family's model after a five-hour tie", () => {
		const seats = [
			seat("opus-heavy", {
				unified5h: window(now + hour, 0.4),
				unified7d: window(now + 6 * 24 * hour, 0.2),
				unified7dOpus: aheadOfPaceWeek,
			}),
			seat("even", {
				unified5h: window(now + hour, 0.4),
				unified7d: window(now + 6 * 24 * hour, 0.3),
			}),
		];
		expect(order(seats, "claude-opus-4-5")).toEqual(["even", "opus-heavy"]);
		expect(order(seats, "claude-sonnet-4-5")).toEqual(["opus-heavy", "even"]);
	});
});
