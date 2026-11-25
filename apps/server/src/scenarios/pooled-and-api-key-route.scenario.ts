import { defineScenario } from "./harness/scenario";
import {
	standaloneRequest,
	standaloneWire,
	wireDeviceKey,
	wireProxyKey,
} from "./harness/wire-fixture";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;
const interactive = { "x-agent-smith-interactive-provider-choice": "v1" };

export default defineScenario({
	...standaloneWire,
	name: "a pooled seat and API key serve the same route and appear in caller status",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: {
					members: ["seat-a", "seat-b"],
				},
			},
			acme: {
				enabled: true,
				strategy: "anthropic-api",
				pool: {
					members: ["seat-a", "seat-b"],
				},
			},
			anthropic: {
				pool: {
					members: ["seat-a", "seat-b"],
				},
			},
			openai: {
				pool: {
					members: ["seat-a", "seat-b"],
				},
			},
			codex: {
				pool: {
					members: ["seat-a", "seat-b"],
				},
			},
		},
		routing: {
			routes: {
				"anthropic-messages": ["claude-code", "acme"],
			},
			api_key_accounts: "chooser_or_fallback",
			callers: {
				"synthetic-device": {
					allow_fallbacks: true,
				},
			},
			hold_seconds: 0,
		},
	},
	fleet: [
		{
			name: "seat-a",
			provider: "claude-code",
			authMethod: "oauth",
			accountUuid: "seat-a",
			priority: 0,
		},
		{
			name: "seat-b",
			provider: "claude-code",
			authMethod: "oauth",
			accountUuid: "seat-b",
			priority: 1,
		},
		{ name: "api-key", provider: "acme", authMethod: "api_key" },
	],
	upstream: [
		{
			account: "seat-a",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
		},
		{
			account: "api-key",
			path: "/v1/messages",
			status: 200,
			json: { ok: true },
		},
	],
	steps: [
		{
			type: "request",
			transport: "unix",
			id: "caller-status",
			method: "GET",
			path: "/api/pool-status?pool=anthropic-messages",
			headers: {
				"x-api-key": wireProxyKey,
				"x-agent-smith-device-key": wireDeviceKey,
			},
			body: "",
		},
		{
			type: "request",
			transport: "unix",
			id: "provider-status",
			method: "GET",
			path: "/api/pool-status?provider=claude-code",
			headers: { "x-api-key": wireProxyKey },
			body: "",
		},
		{
			...standaloneRequest,
			id: "pooled-turn",
			body,
			headers: { ...standaloneRequest.headers, ...interactive },
		},
		{
			...standaloneRequest,
			id: "api-key-turn",
			body,
			headers: {
				...standaloneRequest.headers,
				...interactive,
				"x-agent-smith-provider-choice": "acme",
			},
		},
	],
	assertions: [
		{
			id: "caller-reaches-three-seats",
			type: "client",
			request: "caller-status",
			status: 200,
			jsonPath: { path: "eligibleAccounts", value: 3 },
		},
		{
			id: "provider-status-counts-pooled-seats",
			type: "client",
			request: "provider-status",
			status: 200,
			jsonPath: { path: "eligibleAccounts", value: 2 },
		},
		{
			id: "pooled-provider-serves",
			type: "client",
			request: "pooled-turn",
			status: 200,
			header: { name: "x-agent-smith-served-provider", value: "claude-code" },
		},
		{
			id: "api-provider-serves",
			type: "client",
			request: "api-key-turn",
			status: 200,
			header: { name: "x-agent-smith-served-provider", value: "acme" },
		},
		{
			id: "both-provider-kinds-receive-one-turn",
			type: "upstream",
			accounts: ["seat-a", "api-key"],
			bodyIdentical: body,
		},
	],
});
