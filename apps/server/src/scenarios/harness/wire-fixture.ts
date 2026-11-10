import type { Scenario } from "./scenario";

export const wireDeviceKey = "synthetic-scenario-device-key-0001";
export const wireAdminKey = "synthetic-scenario-administrator-key-0001";
export const wireProxyKey = "synthetic-scenario-internal-proxy-key-0001";

/** Synthetic wire data shared by edge/provider scenarios; never real credentials. */
export const poolWire = {
	edge: {},
	upstreamRuntime: "node",
	config: {
		provider_pools: { "anthropic-messages": ["claude-code"] },
		payload_storage_enabled: false,
		team_routing: { enabled: false, quota_probe_seconds: 0 },
	},
	fleet: [
		{ name: "primary", provider: "claude-code" },
		{ name: "sibling", provider: "claude-code" },
	],
} satisfies Pick<Scenario, "edge" | "upstreamRuntime" | "config" | "fleet">;

export const poolRequest = {
	type: "request",
	transport: "edge",
	path: "/v1/pool/anthropic-messages/v1/messages",
	body: '{"model":"synthetic-model","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"Synthetic cancellation regression"}]}',
} as const;

export const standaloneWire = {
	...poolWire,
	edge: undefined,
	standalone: true,
};

export const standaloneHeaders = {
	host: "pool.example",
	connection: "close",
};

export const standaloneRequest = {
	...poolRequest,
	transport: "tcp",
	headers: { ...standaloneHeaders, "x-api-key": wireDeviceKey },
} as const;

export const drainControl = {
	type: "request",
	transport: "unix",
	path: "/api/drain",
	body: "",
	headers: { "x-api-key": wireAdminKey },
} as const;

export const providerChunk =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_synthetic_cancel","type":"message","role":"assistant","model":"synthetic-model","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}\n\n';
