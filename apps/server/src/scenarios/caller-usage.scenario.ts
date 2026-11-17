import { createHash } from "node:crypto";
import {
	type ClientAssertion,
	defineScenario,
	type RequestStep,
} from "./harness/scenario";
import { wireAdminKey, wireProxyKey } from "./harness/wire-fixture";

const alpha = "synthetic-caller-alpha-device-key-0001";
const beta = "synthetic-caller-beta-laptop-key-0001";
const betaDesktop = "synthetic-caller-beta-desktop-key-0001";
const digest = (key: string) => createHash("sha256").update(key).digest("hex");
const usage = {
	input_tokens: 10,
	output_tokens: 2,
	cache_read_input_tokens: 3,
	cache_creation_input_tokens: 4,
};
const body = (model = "model-a") =>
	JSON.stringify({
		model,
		messages: [],
		metadata: { user_id: "spoofed-owner" },
		callerId: "spoofed-owner",
	});
const infer = (key: string, model = "model-a"): RequestStep => ({
	type: "request",
	body: body(model),
	headers: { "x-api-key": key, "x-caller-id": "spoofed-owner" },
});
const report = (
	id: string,
	query = "range=24h",
	key: string | null = wireAdminKey,
	transport: "tcp" | "unix" = "unix",
): RequestStep => ({
	type: "request",
	id,
	transport,
	method: "GET",
	path: `/api/usage/callers?${query}`,
	body: "",
	headers: key ? { "x-api-key": key } : {},
});
const fields = (
	request: string,
	values: Record<string, unknown>,
): ClientAssertion[] =>
	Object.entries(values).map(([path, value]) => ({
		id: `${request}-${path}`,
		type: "client",
		request,
		status: 200,
		jsonPath: { path, value },
	}));
const streamStart =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_synthetic","model":"model-a","usage":{"input_tokens":20,"output_tokens":0,"cache_read_input_tokens":6,"cache_creation_input_tokens":7}}}\n\n';
const streamEnd =
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

// Case table: overlapping callers/grouped keys; streamed failover; durable filters;
// admin-only report on TCP/Unix; caller identities excluded from ordinary metadata.
export default defineScenario({
	name: "authenticated caller usage survives streaming, failover and restart privately",
	privateSocket: true,
	deviceKeys: {
		"caller-alpha": digest(alpha),
		laptop: { sha256: digest(beta), callerId: "caller-beta" },
		desktop: { sha256: digest(betaDesktop), callerId: "caller-beta" },
	},
	environment: {
		AGENT_SMITH_ADMIN_KEY: wireAdminKey,
		AGENT_SMITH_PROXY_KEY: wireProxyKey,
	},
	config: {
		payload_storage_enabled: false,
		team_routing: { enabled: false, quota_probe_seconds: 0 },
	},
	fleet: [
		{ name: "pooled-a", tokenExpiresIn: "48h" },
		{ name: "pooled-b", tokenExpiresIn: "48h" },
	],
	upstream: [
		{
			id: "overlap",
			account: "pooled-a",
			times: 1,
			status: 200,
			json: { model: "model-a", usage },
			hold: { received: 1, release: "manual" },
		},
		{
			account: "pooled-a",
			times: 1,
			status: 200,
			json: { model: "model-a", usage },
		},
		{
			account: "pooled-a",
			times: 1,
			status: 200,
			json: { model: "model-b", usage },
		},
		{
			account: "pooled-a",
			times: 1,
			status: 200,
			sse: [
				{
					body: 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n',
				},
			],
		},
		{
			account: "pooled-b",
			times: 1,
			status: 200,
			sse: [{ body: streamStart }, { body: streamEnd, afterClientChunk: true }],
		},
		{ status: 200, json: { model: "model-a", usage } },
	],
	steps: [
		{
			...infer(alpha),
			id: "alpha-overlap",
			waitForCompletion: false,
			waitForUpstream: 1,
		},
		{ ...infer(beta), id: "beta-overlap" },
		{
			type: "assert",
			assertions: [
				{
					id: "two-callers-share-one-seat",
					type: "upstream",
					count: 2,
					accounts: ["pooled-a", "pooled-a"],
				},
			],
		},
		{ type: "release", id: "overlap" },
		{ type: "await", id: "alpha-overlap" },
		{ type: "advance", by: "2h" },
		{ ...infer(betaDesktop, "model-b"), id: "beta-desktop" },
		{
			...infer(alpha),
			id: "alpha-stream",
			body: '{"model":"model-a","stream":true,"messages":[]}',
		},
		{ ...infer(wireProxyKey), id: "shared-proxy" },
		{ type: "flush", usageWorker: true },
		{ type: "restart" },
		report("all"),
		report("alpha", "range=24h&caller=caller-alpha"),
		report("beta", "range=24h&caller=caller-beta"),
		report("model", "range=24h&model=model-b"),
		report("recent", "range=1h&caller=caller-alpha"),
		report("denied", "range=24h", null, "tcp"),
		report("denied", "range=24h", null),
		report("denied", "range=24h", alpha),
		report("denied", "range=24h", wireProxyKey),
		{
			...report("origin"),
			headers: {
				"x-api-key": wireAdminKey,
				origin: "https://attacker.example",
			},
		},
		{ ...report("metadata", "", wireProxyKey, "tcp"), path: "/api/requests" },
	],
	assertions: [
		{
			id: "five-client-requests-share-seats-with-one-failover",
			type: "upstream",
			count: 6,
			atMostPerHeader: { name: "x-agent-smith-scenario-client-id", count: 2 },
		},
		{
			id: "stream-remains-native",
			type: "client",
			request: "alpha-stream",
			status: 200,
			chunks: [streamStart, streamEnd],
		},
		...fields("all", {
			"rows.length": 3,
			"rows.2.callerId": null,
			"rows.2.requests": 1,
			"rows.2.totalTokens": 19,
			models: ["model-a", "model-b"],
			startMs: 1_700_000_000_000 + 2 * 3_600_000 - 24 * 3_600_000,
			endMs: 1_700_000_000_000 + 2 * 3_600_000,
		}),
		...fields("alpha", {
			"rows.length": 1,
			"rows.0.callerId": "caller-alpha",
			"rows.0.requests": 2,
			"rows.0.inputTokens": 30,
			"rows.0.outputTokens": 7,
			"rows.0.cacheReadInputTokens": 9,
			"rows.0.cacheCreationInputTokens": 11,
			"rows.0.totalTokens": 57,
			"rows.0.pendingRequests": 0,
			"rows.0.unreportedRequests": 0,
		}),
		...fields("beta", {
			"rows.length": 1,
			"rows.0.callerId": "caller-beta",
			"rows.0.requests": 2,
			"rows.0.totalTokens": 38,
		}),
		...fields("model", {
			"rows.length": 1,
			"rows.0.callerId": "caller-beta",
			"rows.0.requests": 1,
			"rows.0.totalTokens": 19,
			models: ["model-a", "model-b"],
		}),
		...fields("recent", { "rows.0.requests": 1, "rows.0.totalTokens": 38 }),
		{
			id: "report-requires-admin-even-on-loopback-and-unix",
			type: "client",
			request: "denied",
			statuses: [401, 401, 403, 401],
		},
		{
			id: "report-keeps-origin-check",
			type: "client",
			request: "origin",
			status: 403,
		},
		{
			id: "report-has-no-device-keys-or-subscription-identities",
			type: "client",
			request: "all",
			bodyExcludes: [
				alpha,
				beta,
				betaDesktop,
				digest(alpha),
				"pooled-a",
				"pooled-b",
				"spoofed-owner",
				"laptop",
				"desktop",
			],
			headerIncludes: { name: "cache-control", value: "no-store" },
		},
		{
			id: "ordinary-metadata-does-not-expose-callers",
			type: "client",
			request: "metadata",
			status: 200,
			bodyExcludes: ["caller-alpha", "caller-beta", "callerId", "caller_id"],
		},
	],
});
