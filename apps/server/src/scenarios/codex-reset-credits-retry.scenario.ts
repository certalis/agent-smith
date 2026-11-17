import {
	readResetAccount,
	readResetQuota,
	redeemCredit,
	resetConfig,
	resetConsume,
	resetEnvironment,
	resetFleet,
	resetRequestId,
	usageReply,
} from "./harness/reset-credits-fixture";
import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "Codex reset attempts are exclusive per account and uncertain retries keep the provider request identity after restart",
	codexBackend: true,
	config: resetConfig,
	environment: resetEnvironment,
	fleet: [...resetFleet],
	upstream: [
		{
			id: "uncertain",
			account: "codex",
			path: resetConsume,
			times: 1,
			status: 503,
			json: { error: "uncertain provider response" },
			hold: { received: 1, release: "manual" },
		},
		{
			account: "codex",
			path: resetConsume,
			status: 200,
			json: { code: "already_redeemed", windows_reset: 2 },
		},
		usageReply,
	],
	steps: [
		readResetAccount,
		{ ...redeemCredit("first"), waitForCompletion: false, waitForUpstream: 1 },
		redeemCredit("concurrent"),
		{
			type: "assert",
			assertions: [
				{
					id: "concurrent-attempt-is-refused",
					type: "client",
					request: "concurrent",
					status: 409,
				},
				{
					id: "only-one-provider-redemption-is-in-flight",
					type: "upstream",
					onPath: resetConsume,
					count: 1,
				},
			],
		},
		{ type: "release", id: "uncertain" },
		{ type: "await", id: "first" },
		{ ...readResetQuota, id: "uncertain-quota" },
		{ type: "restart" },
		redeemCredit("retry"),
		readResetQuota,
	],
	assertions: [
		{
			id: "uncertain-attempt-reports-failure",
			type: "client",
			request: "first",
			status: 502,
		},
		{
			id: "uncertain-attempt-keeps-original-usage",
			type: "client",
			request: "uncertain-quota",
			jsonPath: {
				path: "accounts.0.quotaWindows.unified5h.utilization",
				value: 0.9,
			},
		},
		{
			id: "provider-recognizes-the-stable-retry",
			type: "client",
			request: "retry",
			status: 200,
			bodyIncludes: '"code":"already_redeemed"',
			jsonPath: { path: "quotaRefreshed", value: true },
		},
		{
			id: "both-attempts-use-the-same-selected-grant-and-request-id",
			type: "upstream",
			onPath: resetConsume,
			count: 2,
			accounts: ["codex", "codex"],
			bodyIncludes: [
				'"credit_id":"grant-one"',
				`"redeem_request_id":"${resetRequestId}"`,
			],
		},
		{
			id: "already-applied-reset-refreshes-provider-usage",
			type: "client",
			request: "quota",
			jsonPath: {
				path: "accounts.0.quotaWindows.unified5h.utilization",
				value: 0.15,
			},
		},
	],
});
