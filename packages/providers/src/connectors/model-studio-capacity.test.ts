import { expect, test } from "bun:test";
import { classifyModelStudioCapacityBlock } from "./model-studio-capacity";

test("keeps Model Studio capacity parsing in the connector layer", async () => {
	const response = new Response(
		JSON.stringify({ code: "Throttling.AllocationQuota" }),
		{ headers: { "content-type": "application/json" }, status: 429 },
	);

	expect(await classifyModelStudioCapacityBlock(response, 0)).toEqual({
		category: "token-allocation",
	});
});

test.each([
	["Throttling.RateQuota", "request-rate"],
	["Throttling.AllocationQuota", "token-allocation"],
	["Throttling.BurstRate", "burst"],
	["Throttling.ResourceExhausted", "dynamic-throughput"],
	["Throttling.ServiceOverloaded", "dynamic-throughput"],
	["ServiceUnavailable", "temporary-capacity"],
] as const)("classifies Model Studio %s as %s", async (code, category) => {
	const result = await classifyModelStudioCapacityBlock(
		new Response(JSON.stringify({ code, message: "provider message" }), {
			status: code === "ServiceUnavailable" ? 503 : 429,
			headers: { "content-type": "application/json" },
		}),
	);

	expect(result).toEqual({ category });
});

test("classifies a real Model Studio concurrency throttle as a burst", async () => {
	const response = new Response(
		'{"request_id":"…","code":"Throttling","message":"Too many concurrent requests."}',
		{ headers: { "content-type": "application/json" }, status: 429 },
	);

	expect(await classifyModelStudioCapacityBlock(response)).toEqual({
		category: "burst",
	});
});

test("keeps unfamiliar Model Studio 429 responses and large bodies honest", async () => {
	const unknown = await classifyModelStudioCapacityBlock(
		new Response(JSON.stringify({ code: "Throttling.NewLimit" }), {
			status: 429,
			headers: { "content-type": "application/json" },
		}),
	);
	const large = await classifyModelStudioCapacityBlock(
		new Response(JSON.stringify({ code: "Throttling.RateQuota" }), {
			status: 429,
			headers: {
				"content-length": "65537",
				"content-type": "application/json",
			},
		}),
	);

	expect(unknown).toEqual({ category: "unknown" });
	expect(large).toEqual({ category: "unknown" });
});

test("uses an upstream Retry-After deadline without manufacturing one", async () => {
	const now = Date.now();
	const withRetryAfter = await classifyModelStudioCapacityBlock(
		new Response(JSON.stringify({ code: "Throttling.RateQuota" }), {
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": "30",
			},
		}),
		now,
	);
	const withoutRetryAfter = await classifyModelStudioCapacityBlock(
		new Response(JSON.stringify({ code: "Throttling.RateQuota" }), {
			status: 429,
			headers: { "content-type": "application/json" },
		}),
		now,
	);

	expect(withRetryAfter).toEqual({
		category: "request-rate",
		retryAt: now + 30_000,
	});
	expect(withoutRetryAfter).toEqual({ category: "request-rate" });
});
