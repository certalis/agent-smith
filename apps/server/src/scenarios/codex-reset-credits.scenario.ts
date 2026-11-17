import {
	grant,
	grantReply,
	inspectCredits,
	readResetAccount,
	readResetQuota,
	redeemCredit,
	resetAdmin,
	resetBackend,
	resetConfig,
	resetConsume,
	resetEnvironment,
	resetFleet,
	resetRequestId,
	usageBackend,
	usageReply,
} from "./harness/reset-credits-fixture";
import { defineScenario } from "./harness/scenario";

export default defineScenario({
	name: "Codex grants are inspected without redemption and confirmed resets refresh reported windows",
	codexBackend: true,
	config: resetConfig,
	environment: resetEnvironment,
	fleet: [...resetFleet],
	upstream: [
		grantReply,
		{
			account: "codex",
			path: resetConsume,
			status: 200,
			json: { code: "reset", windows_reset: 2 },
		},
		usageReply,
	],
	steps: [
		readResetAccount,
		{
			...inspectCredits("inspection"),
			headers: {
				...resetAdmin,
				authorization: "Bearer client-owned-token",
				"chatgpt-account-id": "caller-seat",
			},
		},
		{
			type: "assert",
			assertions: [
				{
					id: "inspection-never-redeems",
					type: "upstream",
					onPath: resetConsume,
					count: 0,
				},
				{
					id: "inspection-never-refreshes-usage",
					type: "upstream",
					onPath: usageBackend,
					count: 0,
				},
			],
		},
		redeemCredit("reset"),
		{ ...readResetAccount, id: "after", capture: undefined },
		readResetQuota,
	],
	assertions: [
		{
			id: "inspection-returns-count",
			type: "client",
			request: "inspection",
			status: 200,
			jsonPath: { path: "availableCount", value: 1 },
		},
		{
			id: "inspection-returns-grant-expiry",
			type: "client",
			request: "inspection",
			jsonPath: {
				path: "credits.0",
				value: {
					id: grant.id,
					resetType: grant.reset_type,
					status: grant.status,
					grantedAt: grant.granted_at,
					expiresAt: grant.expires_at,
					title: grant.title,
					description: grant.description,
				},
			},
			bodyExcludes: ["tok-codex", "refresh-codex"],
		},
		{
			id: "list-uses-saved-token",
			type: "upstream",
			onPath: resetBackend,
			count: 1,
			accounts: ["codex"],
			header: { name: "chatgpt-account-id", value: "synthetic-codex-account" },
		},
		{
			id: "redeem-carries-selected-grant-and-stable-request",
			type: "upstream",
			onPath: resetConsume,
			count: 1,
			accounts: ["codex"],
			bodyIncludes: [
				'"credit_id":"grant-one"',
				`"redeem_request_id":"${resetRequestId}"`,
			],
		},
		{
			id: "reset-reports-refreshed-quota",
			type: "client",
			request: "reset",
			status: 200,
			jsonPath: { path: "quotaRefreshed", value: true },
			bodyIncludes: '"code":"reset"',
		},
		{
			id: "provider-five-hour-usage-is-persisted",
			type: "client",
			request: "quota",
			jsonPath: {
				path: "accounts.0.quotaWindows.unified5h.utilization",
				value: 0.15,
			},
		},
		{
			id: "provider-weekly-usage-is-persisted",
			type: "client",
			request: "quota",
			jsonPath: {
				path: "accounts.0.quotaWindows.unified7d.utilization",
				value: 0.2,
			},
		},
		{
			id: "unreported-quota-window-is-preserved",
			type: "client",
			request: "quota",
			jsonPath: {
				path: "accounts.0.quotaWindows.unified7dFable.utilization",
				value: 0.6,
			},
		},
		{
			id: "reset-does-not-unpause-seat",
			type: "client",
			request: "after",
			jsonPath: { path: "0.paused", value: true },
		},
	],
});
