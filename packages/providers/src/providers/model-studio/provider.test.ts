import { expect, test } from "bun:test";
import { ModelStudioAnthropicProvider } from "./provider";

test("does not invent a Model Studio cooldown when the upstream supplied no deadline", () => {
	const provider = new ModelStudioAnthropicProvider();

	expect(
		provider.parseRateLimit(
			new Response(JSON.stringify({ code: "Throttling.RateQuota" }), {
				status: 429,
				headers: { "content-type": "application/json" },
			}),
		),
	).toEqual({ isRateLimited: true });
});

test("uses the connector Retry-After parser for Model Studio rate limits", () => {
	const provider = new ModelStudioAnthropicProvider();
	const before = Date.now();
	const result = provider.parseRateLimit(
		new Response(null, { status: 429, headers: { "retry-after": "30" } }),
	);

	expect(result.isRateLimited).toBe(true);
	expect(result.resetTime).toBeGreaterThanOrEqual(before + 30_000);
	expect(result.resetTime).toBeLessThanOrEqual(Date.now() + 30_000);
});

test("reads Model Studio capacity detail from a cloned response", async () => {
	const provider = new ModelStudioAnthropicProvider();
	const response = new Response(
		JSON.stringify({ code: "Throttling.AllocationQuota" }),
		{
			status: 429,
			headers: { "content-type": "application/json" },
		},
	);

	expect(await provider.getCapacityBlock(response)).toEqual({
		category: "token-allocation",
	});
	expect(await response.json()).toEqual({
		code: "Throttling.AllocationQuota",
	});
});
