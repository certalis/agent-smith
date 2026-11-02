import { defineScenario, type RequestStep } from "./harness/scenario";

const origin = "https://pool.example.test";
const publicHeaders = { host: "pool.example.test", origin };
const missingToken = "x".repeat(43);
const capabilityBody = JSON.stringify({ token: missingToken });
const publicRequest = (
	path: string,
	options: Partial<RequestStep> = {},
): RequestStep => ({
	type: "request",
	path,
	body: capabilityBody,
	headers: publicHeaders,
	...options,
});

const cases: { id: string; request: RequestStep; status: number }[] = [
	{
		id: "page-needs-no-key-on-configured-host",
		request: publicRequest("/pool-enroll", { method: "GET" }),
		status: 200,
	},
	{
		id: "public-host-is-exact",
		request: publicRequest("/pool-enroll", {
			method: "GET",
			headers: { host: "attacker.example" },
		}),
		status: 403,
	},
	{
		id: "invitation-cannot-arrive-in-query",
		request: publicRequest(`/pool-enroll?token=${missingToken}`, {
			method: "GET",
		}),
		status: 400,
	},
	{
		id: "public-post-requires-origin",
		request: publicRequest("/pool-enroll/start", {
			headers: { host: "pool.example.test" },
		}),
		status: 403,
	},
	{
		id: "origin-scheme-is-exact-even-with-admin-key",
		request: publicRequest("/pool-enroll/start", {
			headers: {
				...publicHeaders,
				origin: "http://pool.example.test",
				"x-api-key": "scenario-admin-key",
			},
		}),
		status: 403,
	},
	{
		id: "public-body-cap-precedes-capability-lookup",
		request: publicRequest("/pool-enroll/start", {
			body: JSON.stringify({ token: missingToken, padding: "x".repeat(8192) }),
		}),
		status: 413,
	},
	...(["start", "verify", "confirm", "disconnect"] as const).map((stage) => ({
		id: `${stage}-rejects-unissued-capability-without-proxy-key`,
		request: publicRequest(`/pool-enroll/${stage}`, {
			body: JSON.stringify({
				token: missingToken,
				...(stage === "verify"
					? { code: "synthetic-code#synthetic-state" }
					: {}),
				...(stage === "confirm" ? { consent: true } : {}),
			}),
		}),
		status: 410,
	})),
	{
		id: "forwarding-key-is-not-an-enrollment-capability",
		request: publicRequest("/pool-enroll/start", {
			body: JSON.stringify({ token: "scenario-proxy-key" }),
		}),
		status: 410,
	},
	{
		id: "page-rejects-post",
		request: publicRequest("/pool-enroll"),
		status: 405,
	},
	{
		id: "start-rejects-get",
		request: publicRequest("/pool-enroll/start", { method: "GET" }),
		status: 405,
	},
	{
		id: "verify-rejects-patch",
		request: publicRequest("/pool-enroll/verify", { method: "PATCH" }),
		status: 405,
	},
	{
		id: "disconnect-rejects-get",
		request: publicRequest("/pool-enroll/disconnect", { method: "GET" }),
		status: 405,
	},
	{
		id: "disconnect-subpaths-retain-key-boundary",
		request: publicRequest("/pool-enroll/disconnect/extra"),
		status: 401,
	},
	{
		id: "unknown-public-path-retains-key-boundary",
		request: publicRequest("/pool-enroll/start/extra"),
		status: 401,
	},
	{
		id: "dot-segments-never-reach-management",
		request: publicRequest("/pool-enroll/..%2fapi/accounts"),
		status: 400,
	},
	{
		id: "enrollment-token-cannot-read-management",
		request: publicRequest("/api/accounts", {
			method: "GET",
			headers: { ...publicHeaders, "x-api-key": missingToken },
		}),
		status: 401,
	},
	{
		id: "enrollment-origin-cannot-authorize-inference",
		request: publicRequest("/v1/claude-code/v1/messages"),
		status: 401,
	},
	{
		id: "invitation-issuance-requires-authentication",
		request: {
			type: "request",
			path: "/api/enrollment-invitations",
			body: "{}",
		},
		status: 401,
	},
	{
		id: "proxy-key-cannot-issue-invitation",
		request: {
			type: "request",
			path: "/api/enrollment-invitations",
			body: "{}",
			headers: { "x-api-key": "scenario-proxy-key" },
		},
		status: 401,
	},
	{
		id: "unknown-invitation-fields-are-not-accepted",
		request: {
			type: "request",
			path: "/api/enrollment-invitations",
			body: '{"redirectUrl":"https://attacker.example"}',
			headers: { "x-api-key": "scenario-admin-key" },
		},
		status: 400,
	},
	{
		id: "admin-can-issue-without-personal-metadata",
		request: {
			type: "request",
			path: "/api/enrollment-invitations",
			body: "{}",
			headers: { "x-api-key": "scenario-admin-key" },
		},
		status: 201,
	},
];

export default defineScenario({
	name: "private enrollment exposes only a bounded invitation surface",
	environment: {
		CF_ADMIN_KEY: "scenario-admin-key",
		CF_PROXY_KEY: "scenario-proxy-key",
		CF_TRUST_LOOPBACK: "false",
		CF_ENROLLMENT_ORIGIN: origin,
	},
	fleet: [],
	upstream: [],
	steps: cases.map(({ request }) => request),
	assertions: [
		...cases.map(({ id, status }, index) => ({
			id,
			type: "client" as const,
			index,
			status,
		})),
		{
			id: "page-cannot-be-cached",
			type: "client",
			index: 0,
			header: { name: "cache-control", value: "no-store" },
		},
		{
			id: "page-cannot-leak-referrers",
			type: "client",
			index: 0,
			header: { name: "referrer-policy", value: "no-referrer" },
		},
		{
			id: "invitation-uses-configured-origin-and-fragment",
			type: "client",
			index: cases.length - 1,
			bodyIncludes: `${origin}/pool-enroll#`,
		},
		{ id: "enrollment-never-reaches-inference", type: "upstream", count: 0 },
	],
});
