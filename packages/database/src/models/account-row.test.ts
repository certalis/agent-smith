import { describe, expect, it } from "bun:test";
import { type AccountRow, toAccount } from "./account-row";

describe("toAccount", () => {
	it("maps weight, auth_method, base_url, and nullable refresh_token", () => {
		const row: AccountRow = {
			id: "account-1",
			name: "OpenAI API Key",
			provider: "openai",
			auth_method: "api_key",
			base_url: "https://example.com/v1",
			api_key: "sk-test",
			refresh_token: null,
			access_token: null,
			expires_at: null,
			created_at: 123,
			last_used: 456,
			request_count: 2,
			total_requests: 9,
			rate_limited_until: null,
			session_start: null,
			session_request_count: 0,
			weight: 5,
			paused: 0,
			rate_limit_reset: null,
			rate_limit_status: null,
			rate_limit_remaining: null,
			account_uuid: null,
			organization_uuid: null,
			quota_state: null,
		};

		expect(toAccount(row)).toEqual({
			id: "account-1",
			name: "OpenAI API Key",
			provider: "openai",
			auth_method: "api_key",
			base_url: "https://example.com/v1",
			api_key: "sk-test",
			refresh_token: null,
			access_token: null,
			expires_at: null,
			created_at: 123,
			last_used: 456,
			request_count: 2,
			total_requests: 9,
			rate_limited_until: null,
			session_start: null,
			session_request_count: 0,
			weight: 5,
			priority: 0,
			switch_threshold: null,
			error_reason: null,
			paused: false,
			rate_limit_reset: null,
			rate_limit_status: null,
			rate_limit_remaining: null,
			account_uuid: null,
			organization_uuid: null,
			quota_state: null,
		});
	});

	it("parses a persisted quota observation", () => {
		const row: AccountRow = {
			id: "account-1",
			name: "Claude Code",
			provider: "claude-code",
			auth_method: "oauth",
			base_url: null,
			api_key: null,
			refresh_token: "refresh",
			access_token: "access",
			expires_at: 999,
			created_at: 123,
			last_used: null,
			request_count: 0,
			total_requests: 0,
			weight: 1,
			quota_state: JSON.stringify({
				windows: {
					unified5h: {
						resetAt: 1_700_000_360_000,
						seenAt: 1_700_000_000_000,
						status: "allowed",
						utilization: 0.42,
					},
				},
			}),
		};

		expect(toAccount(row).quota_state).toEqual({
			windows: {
				unified5h: {
					resetAt: 1_700_000_360_000,
					seenAt: 1_700_000_000_000,
					status: "allowed",
					utilization: 0.42,
				},
			},
		});
	});
});
