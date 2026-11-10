import stableLink from "./enrollment-stable-link.scenario";
import { defineScenario, type RequestStep } from "./harness/scenario";
import { standaloneHeaders, wireAdminKey } from "./harness/wire-fixture";

const origin = "https://pool.example";
const headers = { ...standaloneHeaders, origin };
const boundary = [
	{ id: "page", method: "GET", path: "/pool-enroll", status: 200 },
	{
		id: "page-from-team-message",
		method: "GET",
		path: "/pool-enroll",
		headers: { ...standaloneHeaders, "sec-fetch-site": "cross-site" },
		status: 200,
	},
	{
		id: "missing-origin",
		path: "/pool-enroll/start",
		headers: standaloneHeaders,
		status: 403,
	},
	{
		id: "wrong-origin",
		path: "/pool-enroll/start",
		headers: { ...headers, origin: "https://evil.example" },
		status: 403,
	},
	{
		id: "cross-site-post",
		path: "/pool-enroll/start",
		headers: { ...headers, "sec-fetch-site": "cross-site" },
		status: 403,
	},
	{
		id: "wrong-host",
		method: "GET",
		path: "/pool-enroll",
		headers: { ...headers, host: "evil.example" },
		status: 403,
	},
	{
		id: "too-large",
		path: "/pool-enroll/start",
		body: JSON.stringify({ padding: "x".repeat(8192) }),
		status: 413,
	},
	{
		id: "wrong-method",
		method: "GET",
		path: "/pool-enroll/request",
		status: 404,
	},
	{ id: "unknown-action", path: "/pool-enroll/start/extra", status: 404 },
	{
		id: "query-secret",
		method: "GET",
		path: "/pool-enroll?token=secret",
		status: 404,
	},
	{ id: "traversal", path: "/pool-enroll/..%2fapi/accounts", status: 404 },
	{
		id: "public-admin",
		path: "/api/enrollment-emails",
		headers: { ...headers, "x-api-key": wireAdminKey },
		status: 404,
	},
	{ id: "keyless-inference", path: "/v1/claude-code/v1/messages", status: 401 },
	{
		id: "disconnect-needs-capability",
		path: "/pool-enroll/disconnect",
		status: 410,
	},
] satisfies (Partial<RequestStep> & {
	id: string;
	path: string;
	status: number;
})[];

export default defineScenario({
	...stableLink,
	name: "standalone enrollment restores the listed-email sign-in flow without exposing management",
	standalone: true,
	environment: {
		...stableLink.environment,
		AGENT_SMITH_ENROLLMENT_ORIGIN: origin,
	},
	steps: [
		...boundary.map(
			({ status: _, ...step }): RequestStep => ({
				type: "request",
				body: "{}",
				headers,
				...step,
			}),
		),
		...stableLink.steps.map((step) => {
			if (step.type !== "request") return step;
			return step.path?.startsWith("/api/")
				? { ...step, transport: "unix" as const }
				: { ...step, headers };
		}),
	],
	assertions: [
		...stableLink.assertions,
		...boundary.map(({ id, status }) => ({
			id,
			type: "client" as const,
			request: id,
			status,
		})),
		{
			id: "page-keeps-referrer-protection",
			type: "client",
			request: "page",
			header: { name: "referrer-policy", value: "no-referrer" },
		},
		{
			id: "page-keeps-frame-protection",
			type: "client",
			request: "page",
			header: { name: "x-frame-options", value: "DENY" },
		},
	],
});
