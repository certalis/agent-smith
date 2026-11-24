import { describe, expect, it } from "bun:test";
import { classifyGoogleGeminiCapacityBlock } from "./google-gemini-capacity";

describe("classifyGoogleGeminiCapacityBlock", () => {
	it("classifies Google's documented RESOURCE_EXHAUSTED body without guessing a reset", async () => {
		const response = new Response(
			JSON.stringify({
				error: {
					code: 429,
					message: "Resource has been exhausted (e.g. check quota).",
					status: "RESOURCE_EXHAUSTED",
				},
			}),
			{ status: 429, headers: { "content-type": "application/json" } },
		);

		expect(await classifyGoogleGeminiCapacityBlock(response)).toEqual({
			category: "unknown",
		});
	});

	it("retains an explicit retry time as a request-rate fact", async () => {
		const response = new Response(
			JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }),
			{
				status: 429,
				headers: {
					"content-type": "application/json",
					"retry-after": "12",
				},
			},
		);

		expect(await classifyGoogleGeminiCapacityBlock(response, 10_000)).toEqual({
			category: "request-rate",
			retryAt: 22_000,
		});
	});

	it("does not classify unrelated server errors as capacity", async () => {
		expect(
			await classifyGoogleGeminiCapacityBlock(
				new Response(JSON.stringify({ error: { status: "INTERNAL" } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
			),
		).toBeNull();
	});
});
