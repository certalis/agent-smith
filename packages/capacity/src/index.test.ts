import { expect, test } from "bun:test";
import type { CapacitySource } from "./index";
import { isProviderBlockCategory, PROVIDER_BLOCK_CATEGORIES } from "./index";

test("exports a provider-neutral capacity block vocabulary", () => {
	expect(PROVIDER_BLOCK_CATEGORIES).toEqual([
		"five-hour-limit",
		"weekly-limit",
		"request-rate",
		"token-allocation",
		"burst",
		"dynamic-throughput",
		"temporary-capacity",
		"unknown",
	]);
	expect(isProviderBlockCategory("token-allocation")).toBe(true);
	expect(isProviderBlockCategory("provider-internal-code")).toBe(false);
});

test("describes capacity as a connector-provided source", async () => {
	const source: CapacitySource = {
		async getCapacityBlock() {
			return { category: "burst" };
		},
	};

	expect(
		await source.getCapacityBlock?.(new Response(null, { status: 429 })),
	).toEqual({
		category: "burst",
	});
});
