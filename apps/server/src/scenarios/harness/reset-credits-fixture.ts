import type { RequestStep, UpstreamRule } from "./scenario";
import { wireAdminKey, wireProxyKey } from "./wire-fixture";

export const resetBackend = "/backend-api/wham/rate-limit-reset-credits";
export const resetConsume = `${resetBackend}/consume`;
export const usageBackend = "/backend-api/wham/usage";
export const resetRequestId = "d336ab5a-4d6c-4bce-9db1-11ecc94e0cab";
export const resetAdmin = { "x-api-key": wireAdminKey };
export const resetEnvironment = {
	AGENT_SMITH_TRUST_LOOPBACK: "false",
	AGENT_SMITH_ADMIN_KEY: wireAdminKey,
	AGENT_SMITH_PROXY_KEY: wireProxyKey,
};
export const resetConfig = {
	payload_storage_enabled: false,
	team_routing: { enabled: false, quota_probe_seconds: 0 },
};
export const resetFleet = [
	{
		name: "codex",
		provider: "codex",
		baseUrl: null,
		accountUuid: "synthetic-codex-account",
		paused: true,
		quotaState: {
			windows: {
				unified5h: {
					resetAt: 1_700_018_000_000,
					seenAt: 1_700_000_000_000,
					status: "allowed",
					utilization: 0.9,
				},
				unified7d: {
					resetAt: 1_700_604_800_000,
					seenAt: 1_700_000_000_000,
					status: "allowed",
					utilization: 0.85,
				},
				unified7dFable: {
					resetAt: 1_700_604_800_000,
					seenAt: 1_700_000_000_000,
					status: "allowed",
					utilization: 0.6,
				},
			},
		},
	},
] as const;
const clock = 1_700_000_000_000;
export const grant = {
	id: "grant-one",
	reset_type: "codex_rate_limits",
	status: "available",
	granted_at: new Date(clock - 3_600_000).toISOString(),
	expires_at: new Date(clock + 86_400_000).toISOString(),
	title: "A synthetic reset",
	description: "An operator may redeem this grant once.",
};
export const grantReply: UpstreamRule = {
	account: "codex",
	path: resetBackend,
	status: 200,
	json: { available_count: 1, credits: [grant] },
};
export const usageReply: UpstreamRule = {
	account: "codex",
	path: usageBackend,
	status: 200,
	json: {
		rate_limit: {
			primary_window: {
				used_percent: 15,
				reset_at: (clock + 18_000_000) / 1_000,
				limit_window_seconds: 18_000,
			},
			secondary_window: {
				used_percent: 20,
				reset_at: (clock + 604_800_000) / 1_000,
				limit_window_seconds: 604_800,
			},
		},
	},
};
export const readResetAccount: RequestStep = {
	type: "request",
	method: "GET",
	path: "/api/accounts",
	headers: resetAdmin,
	body: "",
	capture: { seat: { field: "0.id" } },
};
export function inspectCredits(id: string): RequestStep {
	return {
		type: "request",
		id,
		method: "GET",
		path: "/api/accounts/{{seat}}/reset-credits",
		headers: resetAdmin,
		body: "",
	};
}
export const readResetQuota: RequestStep = {
	type: "request",
	id: "quota",
	method: "GET",
	path: "/api/status",
	headers: resetAdmin,
	body: "",
};
export function redeemCredit(
	id: string,
	requestId = resetRequestId,
): RequestStep {
	return {
		type: "request",
		id,
		path: "/api/accounts/{{seat}}/reset-credits/consume",
		headers: resetAdmin,
		body: JSON.stringify({
			confirmed: true,
			creditId: "grant-one",
			requestId,
		}),
	};
}
