import { defineScenario } from "./harness/scenario";
import { poolRequest, poolWire, providerChunk } from "./harness/wire-fixture";

export default defineScenario({
	...poolWire,
	name: "before-header and mid-stream cancellations release the seat admission slot",
	config: {
		provider_pools: { "anthropic-messages": ["claude-code"] },
		payload_storage_enabled: false,
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["seat-a"],
			admission_cap: 1,
			admission_queue_limit: 0,
			quota_probe_seconds: 0,
		},
	},
	fleet: [{ name: "primary", provider: "claude-code", accountUuid: "seat-a" }],
	upstream: [
		{ status: 200, times: 1, keepOpen: "before-headers" },
		{ status: 200, times: 1, json: { ok: "after-headers-cancel" } },
		{
			status: 200,
			times: 1,
			sse: [{ body: providerChunk }],
			keepOpen: "after-chunks",
		},
		{ status: 200, times: 1, json: { ok: "after-stream-cancel" } },
	],
	steps: [
		{
			...poolRequest,
			id: "before",
			waitForCompletion: false,
			waitForUpstream: 1,
		},
		{ type: "cancel", id: "before" },
		{ type: "wait-for-upstream-close", count: 1 },
		{ type: "await", id: "before" },
		{ ...poolRequest, id: "after-before" },
		{ ...poolRequest, id: "stream", waitForCompletion: false },
		{ type: "wait-for-client-chunk", id: "stream" },
		{ type: "cancel", id: "stream" },
		{ type: "wait-for-upstream-close", count: 3 },
		{ type: "await", id: "stream" },
		{ ...poolRequest, id: "after-stream" },
	],
	assertions: [
		{
			id: "before-header-request-cancelled",
			type: "client",
			request: "before",
			cancelled: true,
			status: 0,
		},
		{
			id: "first-replacement-enters",
			type: "client",
			request: "after-before",
			status: 200,
		},
		{
			id: "streaming-request-cancelled",
			type: "client",
			request: "stream",
			cancelled: true,
			status: 200,
		},
		{
			id: "second-replacement-enters",
			type: "client",
			request: "after-stream",
			status: 200,
		},
		{
			id: "one-seat-serves-four-attempts",
			type: "upstream",
			accounts: ["primary", "primary", "primary", "primary"],
		},
	],
});
