import {
	enrollmentConfig,
	enrollmentEnvironment,
	oauthReplies,
	publicHeaders,
	readAccounts,
	requestEmail,
} from "./harness/enrollment-fixture";
import { defineScenario, type RequestStep } from "./harness/scenario";

const browser = (
	id: string,
	action: string,
	body: object = {},
	options: Partial<RequestStep> = {},
): RequestStep => ({
	type: "request",
	id,
	transport: "edge",
	path: `/pool-enroll/${action}`,
	headers: { ...publicHeaders, cookie: "{{browserCookie}}", authorization: "" },
	body: JSON.stringify(body),
	...options,
});
const stages = ["invited", "started", "verified", "connected"];

export default defineScenario({
	name: "enrollment browser cookie recovers each step through the HTTPS edge without gaining pool authority",
	environment: enrollmentEnvironment,
	config: { ...enrollmentConfig, enrollment_emails: ["owner@example.test"] },
	edge: { enrollmentOrigin: "https://pool.example.test" },
	claudeOAuth: true,
	fleet: [],
	upstream: oauthReplies,
	steps: [
		{
			...requestEmail("request", "owner@example.test"),
			transport: "edge",
			capture: { browserCookie: { header: "set-cookie" } },
		},
		browser("invited", "resume"),
		browser(
			"crossOrigin",
			"resume",
			{},
			{
				headers: {
					...publicHeaders,
					cookie: "{{browserCookie}}",
					origin: "https://evil.example",
				},
			},
		),
		browser(
			"start",
			"start",
			{},
			{
				capture: { state: { field: "authUrl", query: "state" } },
			},
		),
		browser("started", "resume"),
		browser("otherTab", "resume"),
		browser("staleTabStart", "start"),
		browser(
			"verify",
			"verify",
			{ code: "synthetic-code#{{state}}" },
			{ count: 2 },
		),
		browser("verified", "resume"),
		browser(
			"confirm",
			"confirm",
			{ consent: true },
			{
				count: 2,
				capture: { oldDisconnect: { field: "token" } },
			},
		),
		browser("connected", "resume"),
		browser(
			"management",
			"resume",
			{},
			{
				method: "GET",
				path: "/api/accounts",
				body: "",
			},
		),
		browser("inference", "resume", {}, { path: "/v1/claude-code/v1/messages" }),
		browser(
			"foreignReset",
			"reset",
			{},
			{
				headers: {
					...publicHeaders,
					cookie: "{{browserCookie}}",
					origin: "https://evil.example",
				},
			},
		),
		browser("stillConnected", "resume"),
		browser("reset", "reset"),
		browser("afterReset", "resume"),
		browser("oldCapability", "disconnect", { token: "{{oldDisconnect}}" }),
		readAccounts("accounts"),
	],
	assertions: [
		...["HttpOnly", "Secure", "SameSite=Strict", "Path=/pool-enroll"].map(
			(value) => ({
				id: `cookie-${value}`,
				type: "client" as const,
				request: "request",
				headerIncludes: { name: "set-cookie", value },
			}),
		),
		...stages.flatMap((stage) => [
			{
				id: `${stage}-restored`,
				type: "client" as const,
				request: stage,
				status: 200,
				jsonPath: { path: "stage", value: stage },
			},
			{
				id: `${stage}-no-secrets`,
				type: "client" as const,
				request: stage,
				bodyExcludes: [
					'"token"',
					"synthetic-access",
					"synthetic-refresh",
					"code_verifier",
					"scenario-admin-key",
				],
			},
		]),
		{
			id: "second-tab-sees-current-step",
			type: "client",
			request: "otherTab",
			jsonPath: { path: "stage", value: "started" },
		},
		{
			id: "stale-tab-cannot-start-twice",
			type: "client",
			request: "staleTabStart",
			status: 410,
		},
		{
			id: "one-code-exchange",
			type: "client",
			request: "verify",
			unorderedStatuses: [200, 410],
		},
		{
			id: "one-consent-save",
			type: "client",
			request: "confirm",
			unorderedStatuses: [200, 410],
		},
		...["crossOrigin", "foreignReset"].map((request) => ({
			id: `${request}-refused`,
			type: "client" as const,
			request,
			status: 403,
		})),
		{
			id: "management-not-exposed",
			type: "client",
			request: "management",
			status: 404,
		},
		{
			id: "inference-no-cookie-authority",
			type: "client",
			request: "inference",
			status: 401,
		},
		{
			id: "foreign-reset-cannot-consume-session",
			type: "client",
			request: "stillConnected",
			jsonPath: { path: "stage", value: "connected" },
		},
		{
			id: "reset-succeeded",
			type: "client",
			request: "reset",
			jsonPath: { path: "reset", value: true },
		},
		{
			id: "reset-clears-cookie",
			type: "client",
			request: "reset",
			headerIncludes: { name: "set-cookie", value: "Max-Age=0" },
		},
		...["afterReset", "oldCapability"].map((request) => ({
			id: `${request}-revoked`,
			type: "client" as const,
			request,
			status: 410,
		})),
		{
			id: "reset-does-not-disconnect-account",
			type: "client",
			request: "accounts",
			jsonPath: { path: "length", value: 1 },
		},
		{ id: "resume-never-calls-provider", type: "upstream", count: 2 },
	],
});
