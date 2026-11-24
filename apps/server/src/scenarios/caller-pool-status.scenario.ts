import { defineScenario } from "./harness/scenario";
import {
	standaloneWire,
	wireDeviceKey,
	wireProxyKey,
} from "./harness/wire-fixture";

const now = 1_700_000_000_000;
const oneWeek = 7 * 24 * 60 * 60 * 1_000;
const unregisteredKey = "synthetic-unregistered-device-key-0002";
const poolPath = "/api/pool-status?pool=anthropic-messages";
const read = (id: string, path: string, headers: Record<string, string>) =>
	({
		type: "request",
		transport: "unix",
		id,
		method: "GET",
		path,
		headers,
		body: "",
	}) as const;

export default defineScenario({
	...standaloneWire,
	name: "a caller's pool status counts the providers its own policy reaches",
	config: {
		providers: {
			"claude-code": { enabled: true },
			acme: {
				enabled: true,
				strategy: "anthropic-api",
				models: { "claude-sonnet-*": "acme-sonnet" },
			},
		},
		provider_pools: {
			"anthropic-messages": ["claude-code", "acme"],
		},
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["claude-seat"],
			max_usage: 0.9,
			weekly_max_usage: 0.95,
			caller_weekly_max_usage: { "synthetic-device": 0.7 },
			caller_provider_fallback: { "synthetic-device": "ordered" },
		},
	},
	fleet: [
		{
			name: "claude",
			provider: "claude-code",
			authMethod: "oauth",
			accountUuid: "claude-seat",
			quotaState: {
				windows: {
					unified7d: {
						resetAt: now + oneWeek,
						seenAt: now,
						status: "allowed",
						utilization: 0.7,
					},
				},
			},
		},
		{ name: "acme", provider: "acme", authMethod: "api_key" },
	],
	upstream: [],
	steps: [
		read("caller", poolPath, {
			"x-api-key": wireProxyKey,
			"x-agent-smith-device-key": wireDeviceKey,
		}),
		read("no-caller", poolPath, { "x-api-key": wireProxyKey }),
		read("unregistered-caller", poolPath, {
			"x-api-key": wireProxyKey,
			"x-agent-smith-device-key": unregisteredKey,
		}),
		read("device-key-alone", poolPath, { "x-api-key": wireDeviceKey }),
		read("provider", "/api/pool-status?provider=claude-code", {
			"x-api-key": wireProxyKey,
		}),
	],
	assertions: [
		{
			id: "seat-at-caller-ceiling-skipped-and-api-key-fallback-counted",
			type: "client",
			request: "caller",
			status: 200,
			body: JSON.stringify({
				version: 1,
				pool: "anthropic-messages",
				provider: "claude-code",
				routingEnabled: true,
				eligibleAccounts: 1,
				retryAtMs: null,
				holdSeconds: 0,
				admissionWaitMs: 30000,
			}),
		},
		{
			id: "pool-read-needs-a-caller",
			type: "client",
			request: "no-caller",
			status: 401,
		},
		{
			id: "unregistered-key-refused-and-never-echoed",
			type: "client",
			request: "unregistered-caller",
			status: 401,
			bodyExcludes: [unregisteredKey],
		},
		{
			id: "device-key-still-cannot-read-pool-status",
			type: "client",
			request: "device-key-alone",
			status: 403,
		},
		{
			id: "provider-read-unchanged-and-caller-blind",
			type: "client",
			request: "provider",
			status: 200,
			body: JSON.stringify({
				version: 1,
				provider: "claude-code",
				routingEnabled: true,
				eligibleAccounts: 1,
				retryAtMs: null,
				holdSeconds: 0,
				admissionWaitMs: 30000,
			}),
		},
		{ id: "no-upstream-work", type: "upstream", count: 0 },
	],
});
