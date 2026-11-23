import { expect, test } from "bun:test";
import { classifyModelStudioCapacityBlock } from "./provider-block";

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

test("keeps an unfamiliar Model Studio 429 honest", async () => {
	const result = await classifyModelStudioCapacityBlock(
		new Response(JSON.stringify({ code: "Throttling.NewLimit" }), {
			status: 429,
			headers: { "content-type": "application/json" },
		}),
	);

	expect(result).toEqual({ category: "unknown" });
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

test("does not consume an unbounded response body to classify a block", async () => {
	const result = await classifyModelStudioCapacityBlock(
		new Response(JSON.stringify({ code: "Throttling.RateQuota" }), {
			status: 429,
			headers: {
				"content-type": "application/json",
				"content-length": "65537",
			},
		}),
	);

	expect(result).toEqual({ category: "unknown" });
});
