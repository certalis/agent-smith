import type { RequestStep, UpstreamRule } from "./scenario";

export const enrollmentEnvironment = {
	AGENT_SMITH_ADMIN_KEY: "scenario-admin-key",
	AGENT_SMITH_PROXY_KEY: "scenario-proxy-key",
	AGENT_SMITH_TRUST_LOOPBACK: "false",
	AGENT_SMITH_ENROLLMENT_ORIGIN: "https://pool.example.test",
};
export const enrollmentConfig = {
	team_routing: {
		enabled: false,
		allowlisted_account_uuids: ["existing-seat"],
		max_usage: 0.85,
		admission_cap: 3,
	},
};
export const publicHeaders = {
	host: "pool.example.test",
	origin: "https://pool.example.test",
};
export const tokenReply: UpstreamRule = {
	path: "/v1/oauth/token",
	status: 200,
	json: {
		access_token: "synthetic-access",
		refresh_token: "synthetic-refresh",
		expires_in: 3600,
	},
};
export function profileReply(
	account = { uuid: "verified-seat", email: "owner@example.test" },
): UpstreamRule {
	return {
		path: "/api/oauth/profile",
		status: 200,
		json: { account, organization: { uuid: "synthetic-org" } },
	};
}
export const oauthReplies = [tokenReply, profileReply()];
export function issue(
	id: string,
	details: Record<string, string> = {},
): RequestStep {
	return {
		type: "request",
		id,
		path: "/api/enrollment-invitations",
		headers: { "x-api-key": "scenario-admin-key" },
		body: JSON.stringify(details),
		capture: { [`${id}Invite`]: { field: "url", fragment: true } },
	};
}
export function start(id: string, count = 1): RequestStep {
	return {
		type: "request",
		id: `${id}-start`,
		path: "/pool-enroll/start",
		headers: publicHeaders,
		body: `{"token":"{{${id}Invite}}"}`,
		count,
		capture: {
			[`${id}Flow`]: { field: "token" },
			[`${id}State`]: { field: "authUrl", query: "state" },
		},
	};
}
export function verify(id: string, capture = true, count = 1): RequestStep {
	return {
		type: "request",
		id: `${id}-verify`,
		path: "/pool-enroll/verify",
		headers: publicHeaders,
		body: `{"token":"{{${id}Flow}}","code":"synthetic-code#{{${id}State}}"}`,
		count,
		...(capture ? { capture: { [`${id}Confirm`]: { field: "token" } } } : {}),
	};
}
export function confirm(id: string, capture = false): RequestStep {
	return {
		type: "request",
		id: `${id}-confirm`,
		path: "/pool-enroll/confirm",
		headers: publicHeaders,
		body: `{"token":"{{${id}Confirm}}","consent":true}`,
		...(capture
			? { capture: { [`${id}Disconnect`]: { field: "token" } } }
			: {}),
	};
}
export function disconnect(
	id: string,
	nextInvite = id,
	capture = true,
): RequestStep {
	return {
		type: "request",
		id: `${id}-disconnect`,
		path: "/pool-enroll/disconnect",
		headers: publicHeaders,
		body: `{"token":"{{${id}Disconnect}}"}`,
		...(capture
			? { capture: { [`${nextInvite}Invite`]: { field: "token" } } }
			: {}),
	};
}
export function readAccounts(id: string): RequestStep {
	return {
		type: "request",
		id,
		method: "GET",
		path: "/api/accounts",
		headers: { "x-api-key": "scenario-proxy-key" },
		body: "",
	};
}
export function readRouting(id: string): RequestStep {
	return { ...readAccounts(id), path: "/api/config/team-routing" };
}
