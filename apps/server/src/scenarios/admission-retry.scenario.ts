import { defineScenario } from "./harness/scenario";
import { poolRequest, poolWire, providerChunk } from "./harness/wire-fixture";

const retries = [
	{ id: "initial", count: undefined, seconds: "1" },
	{ id: "first-retry", count: "1", seconds: "10" },
	{ id: "later-retry", count: "2", seconds: "30" },
	{ id: "bounded", count: "999999999999999999999999", seconds: "30" },
	{ id: "invalid", count: "-1", seconds: "1" },
];

export default defineScenario({
	...poolWire,
	name: "admission 503 responses advertise bounded escalating retries before any provider call",
	config: {
		...poolWire.config,
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["acct-a"],
			admission_cap: 1,
			admission_queue_limit: 1,
			admission_wait_ms: 1_000,
			quota_probe_seconds: 0,
		},
	},
	fleet: [{ name: "a", provider: "claude-code", accountUuid: "acct-a" }],
	upstream: [
		{
			status: 200,
			sse: [{ body: providerChunk }],
			times: 1,
			keepOpen: "after-chunks",
		},
		{ status: 200, json: { ok: true } },
	],
	steps: [
		{ ...poolRequest, id: "active", waitForCompletion: false },
		{ type: "wait-for-client-chunk", id: "active" },
		{
			...poolRequest,
			id: "queued",
			headers: { "x-stainless-retry-count": "1" },
			waitForCompletion: false,
		},
		{ type: "flush" },
		...retries.map(({ id, count }) => ({
			...poolRequest,
			id,
			headers:
				count === undefined ? undefined : { "x-stainless-retry-count": count },
		})),
		{ type: "advance", by: "2s" },
		{ type: "await", id: "queued" },
		{ type: "cancel", id: "active" },
		{ type: "wait-for-upstream-close", count: 1 },
		{ type: "await", id: "active" },
		{
			...poolRequest,
			id: "success",
			headers: { "x-stainless-retry-count": "2" },
		},
	],
	assertions: [
		...retries.map(({ id, seconds }) => ({
			id: `${id}-retry-delay`,
			type: "client" as const,
			request: id,
			status: 503,
			header: { name: "retry-after", value: seconds },
			jsonPath: { path: "details.service", value: "claude-code" },
		})),
		{
			id: "timeout-also-advertises-retry",
			type: "client",
			request: "queued",
			status: 503,
			header: { name: "retry-after", value: "10" },
			bodyIncludes: "Timed out waiting for account admission",
		},
		{
			id: "successful-retry-has-no-delay",
			type: "client",
			request: "success",
			status: 200,
			headerAbsent: "retry-after",
		},
		{ id: "rejections-never-call-provider", type: "upstream", count: 2 },
	],
});
