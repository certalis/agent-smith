import {
	grantReply,
	inspectCredits,
	readResetAccount,
	redeemCredit,
	resetBackend,
	resetConfig,
	resetEnvironment,
	resetFleet,
} from "./harness/reset-credits-fixture";
import { defineScenario, type RequestStep } from "./harness/scenario";
import { wireDeviceKey, wireProxyKey } from "./harness/wire-fixture";

const rejected: Array<{ step: RequestStep; status: number }> = [
	{
		step: { ...inspectCredits("keyless-inspection"), headers: {} },
		status: 401,
	},
	{ step: { ...redeemCredit("keyless-redemption"), headers: {} }, status: 401 },
	...[wireProxyKey, wireDeviceKey].flatMap((key, index) => [
		{
			step: {
				...inspectCredits(`list-key-${index}`),
				headers: { "x-api-key": key },
			},
			status: index === 0 ? 401 : 403,
		},
		{
			step: {
				...redeemCredit(`redeem-key-${index}`),
				headers: { "x-api-key": key },
			},
			status: index === 0 ? 401 : 403,
		},
	]),
	{
		step: {
			...redeemCredit("cross-origin"),
			headers: {
				...redeemCredit("unused").headers,
				origin: "https://attacker.example",
			},
		},
		status: 403,
	},
	...[
		{
			confirmed: false,
			creditId: "grant-one",
			requestId: "d336ab5a-4d6c-4bce-9db1-11ecc94e0cab",
		},
		{ confirmed: true, creditId: "grant-one", requestId: "not-a-uuid" },
		{ confirmed: true, requestId: "d336ab5a-4d6c-4bce-9db1-11ecc94e0cab" },
	].map((body, index) => ({
		step: { ...redeemCredit(`invalid-${index}`), body: JSON.stringify(body) },
		status: 400,
	})),
	{
		step: {
			...inspectCredits("missing"),
			path: "/api/accounts/missing/reset-credits",
		},
		status: 404,
	},
	...["claude", "custom", "apiKey"].map((account) => ({
		step: {
			...inspectCredits(`unsupported-${account}`),
			path: `/api/accounts/{{${account}}}/reset-credits`,
		},
		status: 400,
	})),
];

export default defineScenario({
	name: "only administrators can inspect Codex grants and only a confirmed valid request may redeem",
	edge: {},
	codexBackend: true,
	config: resetConfig,
	environment: { ...resetEnvironment, AGENT_SMITH_TRUST_LOOPBACK: "true" },
	fleet: [
		...resetFleet,
		{ name: "claude", provider: "claude-code" },
		{ name: "custom", provider: "codex", accountUuid: "custom-seat" },
		{
			name: "api-key",
			provider: "codex",
			authMethod: "api_key",
			baseUrl: null,
		},
	],
	upstream: [grantReply],
	steps: [
		{
			...readResetAccount,
			capture: {
				seat: { field: "0.id" },
				claude: { field: "1.id" },
				custom: { field: "2.id" },
				apiKey: { field: "3.id" },
			},
		},
		...rejected.map(({ step }) => step),
		inspectCredits("admin"),
	],
	assertions: [
		...rejected.map(({ step, status }) => ({
			id: `${step.id}-rejected`,
			type: "client" as const,
			request: step.id,
			status,
		})),
		{
			id: "administrator-can-inspect",
			type: "client",
			request: "admin",
			status: 200,
		},
		{
			id: "only-explicit-admin-inspection-reaches-provider",
			type: "upstream",
			count: 1,
			path: resetBackend,
			accounts: ["codex"],
		},
	],
});
