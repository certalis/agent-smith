import { expect, test } from "bun:test";
import type { Account } from "@ccflare/types";
import { OutsideSpendTracker } from "./outside-spend";

const weeklyProvider = {
	isWeeklyBucket: (bucket: string) => bucket.startsWith("unified7d"),
};

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
	};
}

function weekly(utilization: number) {
	return {
		windows: {
			unified7d: { utilization, resetAt: 50_000, seenAt: 0, status: null },
		},
	};
}

test("counts an idle weekly rise as outside spend but marks a served interval unknown", () => {
	let now = 1_000;
	const tracker = new OutsideSpendTracker(() => now);
	const a = account();
	a.quota_state = tracker.observe(a, weekly(0.3), weeklyProvider as never);
	now += 10_000;
	a.quota_state = tracker.observe(a, weekly(0.34), weeklyProvider as never);
	expect(a.quota_state.outsideSpend?.unified7d?.share).toBeCloseTo(0.04);
	expect(a.quota_state.outsideSpend?.unified7d?.state).toBe("measured");
	tracker.begin(a.id);
	a.quota_state = tracker.observe(a, weekly(0.4), weeklyProvider as never);
	expect(a.quota_state.outsideSpend?.unified7d).toMatchObject({
		share: null,
		state: "not_measurable",
	});
});

test("tracks only windows the provider marks as weekly", () => {
	const tracker = new OutsideSpendTracker();
	const a = account();
	const observed = tracker.observe(a, weekly(0.3), {
		isWeeklyBucket: () => false,
	} as never);

	expect(observed.outsideSpend).toEqual({});
});
