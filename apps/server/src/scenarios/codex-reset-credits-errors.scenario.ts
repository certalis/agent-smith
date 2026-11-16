import {
	readResetAccount,
	readResetQuota,
	redeemCredit,
	resetConfig,
	resetConsume,
	resetEnvironment,
	resetFleet,
	usageBackend,
} from "./harness/reset-credits-fixture";
import { defineScenario } from "./harness/scenario";

const outcomes = [
	{
		id: "no_credit",
		status: 200,
		json: { code: "no_credit", windows_reset: 0 },
	},
	{
		id: "nothing_to_reset",
		status: 200,
		json: { code: "nothing_to_reset", windows_reset: 0 },
	},
	{ id: "unknown", status: 200, json: { code: "surprise", windows_reset: 1 } },
	{
		id: "upstream-failure",
		status: 503,
		json: { error: "tok-codex synthetic upstream secret" },
	},
];

export default defineScenario({
	name: "unapplied or unknown Codex resets never fabricate recovered quota",
	codexBackend: true,
	config: resetConfig,
	environment: resetEnvironment,
	fleet: [...resetFleet],
	upstream: outcomes.map(({ status, json }) => ({
		account: "codex",
		path: resetConsume,
		times: 1,
		status,
		json,
	})),
	steps: [
		readResetAccount,
		...outcomes.flatMap(({ id }, index) => [
			redeemCredit(id, `d336ab5a-4d6c-4bce-9db1-11ecc94e0ca${index}`),
			{ ...readResetQuota, id: `${id}-quota` },
		]),
	],
	assertions: [
		...outcomes.flatMap(({ id }, index) => [
			{
				id: `${id}-status`,
				type: "client" as const,
				request: id,
				status: index < 2 ? 200 : 502,
				bodyExcludes: ["tok-codex", "synthetic upstream secret"],
			},
			{
				id: `${id}-preserves-five-hour-usage`,
				type: "client" as const,
				request: `${id}-quota`,
				jsonPath: {
					path: "accounts.0.quotaWindows.unified5h.utilization",
					value: 0.9,
				},
			},
			{
				id: `${id}-preserves-weekly-usage`,
				type: "client" as const,
				request: `${id}-quota`,
				jsonPath: {
					path: "accounts.0.quotaWindows.unified7d.utilization",
					value: 0.85,
				},
			},
		]),
		...["no_credit", "nothing_to_reset"].map((code) => ({
			id: `${code}-not-refreshed`,
			type: "client" as const,
			request: code,
			bodyIncludes: `"code":"${code}"`,
			jsonPath: { path: "quotaRefreshed", value: false },
		})),
		{
			id: "four-explicit-attempts",
			type: "upstream",
			onPath: resetConsume,
			count: 4,
		},
		{
			id: "uncertain-results-never-read-or-claim-new-usage",
			type: "upstream",
			onPath: usageBackend,
			count: 0,
		},
	],
});
