import { defineScenario } from "./harness/scenario";
import {
	standaloneRequest,
	standaloneWire,
	wireProxyKey,
} from "./harness/wire-fixture";

const now = 1_700_000_000_000;
const body =
	'{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"keep my seat"}]}' as const;

export default defineScenario({
	...standaloneWire,
	name: "two provider pools keep separate members and ceilings while an ordered caller can fall back",
	config: {
		providers: {
			"claude-code": {
				enabled: true,
				pool: { members: ["seat-a"], max_usage: 0.8 },
			},
			"second-claude": {
				enabled: true,
				strategy: "claude-code",
				pool: { members: ["seat-b"], max_usage: 0.9 },
			},
		},
		routing: {
			routes: { "anthropic-messages": ["claude-code", "second-claude"] },
			api_key_accounts: "chooser_or_fallback",
			callers: { "synthetic-device": { allow_fallbacks: true } },
			hold_seconds: 0,
		},
	},
	fleet: [
		{
			name: "seat-a",
			provider: "claude-code",
			accountUuid: "seat-a",
			quotaState: {
				windows: {
					unified5h: {
						resetAt: now + 3_600_000,
						seenAt: now,
						status: "allowed",
						utilization: 0.8,
					},
				},
			},
		},
		{
			name: "seat-b",
			provider: "second-claude",
			accountUuid: "seat-b",
			quotaState: {
				windows: {
					unified5h: {
						resetAt: now + 3_600_000,
						seenAt: now,
						status: "allowed",
						utilization: 0.8,
					},
				},
			},
		},
		{
			name: "protected",
			provider: "second-claude",
			accountUuid: "not-in-second-pool",
			priority: -1,
		},
	],
	upstream: [
		{
			account: "seat-b",
			path: "/v1/messages",
			status: 200,
			times: 2,
			json: { ok: true },
		},
	],
	steps: [
		{
			type: "request",
			transport: "unix",
			id: "ordinary",
			path: "/v1/pool/anthropic-messages/v1/messages",
			headers: { "x-api-key": wireProxyKey },
			body,
		},
		{
			...standaloneRequest,
			id: "ordered",
			body,
			sessionId: "provider-pool-pin",
		},
		{ type: "restart" },
		{
			...standaloneRequest,
			id: "resumed",
			body,
			sessionId: "provider-pool-pin",
		},
	],
	assertions: [
		{
			id: "ordinary-caller-does-not-fall-back",
			type: "client",
			request: "ordinary",
			status: 429,
		},
		{
			id: "ordered-caller-reaches-second-pool",
			type: "client",
			request: "ordered",
			status: 200,
		},
		{
			id: "pin-and-existing-token-survive-restart",
			type: "client",
			request: "resumed",
			status: 200,
		},
		{
			id: "only-second-pool-member-serves",
			type: "upstream",
			accounts: ["seat-b", "seat-b"],
			bodyIdentical: body,
		},
	],
});
