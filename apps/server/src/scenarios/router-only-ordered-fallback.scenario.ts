import { defineScenario } from "./harness/scenario";
import {
	standaloneRequest,
	standaloneWire,
	wireProxyKey,
} from "./harness/wire-fixture";

const body = '{"model":"claude-sonnet-4-5","messages":[]}' as const;
export default defineScenario({
	...standaloneWire,
	name: "a named caller can fall back even when neither provider has a pool",
	config: {
		providers: {
			alpha: { enabled: true, strategy: "anthropic-api" },
			beta: { enabled: true, strategy: "anthropic-api" },
		},
		routing: {
			routes: { "anthropic-messages": ["alpha", "beta"] },
			api_key_accounts: "everyone",
			callers: { "synthetic-device": { allow_fallbacks: true } },
			hold_seconds: 0,
		},
	},
	fleet: [
		{ name: "alpha", provider: "alpha", authMethod: "api_key" },
		{ name: "beta", provider: "beta", authMethod: "api_key" },
	],
	upstream: [
		{
			account: "alpha",
			path: "/v1/messages",
			status: 529,
			times: 2,
			json: { type: "error" },
		},
		{ account: "beta", path: "/v1/messages", status: 200, json: { ok: true } },
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
		{ ...standaloneRequest, id: "ordered", body },
	],
	assertions: [
		{
			id: "ordinary-caller-stays-on-first",
			type: "client",
			request: "ordinary",
			status: 529,
		},
		{
			id: "named-caller-falls-back",
			type: "client",
			request: "ordered",
			status: 200,
		},
		{
			id: "only-ordered-caller-reaches-second",
			type: "upstream",
			accounts: ["alpha", "alpha", "beta"],
			bodyIdentical: body,
		},
	],
});
