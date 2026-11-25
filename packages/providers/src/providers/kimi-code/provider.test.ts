import { expect, test } from "bun:test";
import { KimiCodeAnthropicProvider } from "./provider";

test("reads a bare Kimi Code 429 as a full provider, not a one-request limit", async () => {
	const provider = new KimiCodeAnthropicProvider();

	expect(
		await provider.getCapacityBlock(
			new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
				status: 429,
				headers: { "content-type": "application/json" },
			}),
		),
	).toEqual({ category: "unknown" });
});

test("leaves a served Kimi Code reply unblocked", async () => {
	const provider = new KimiCodeAnthropicProvider();

	expect(await provider.getCapacityBlock(new Response("{}"))).toBeNull();
});
