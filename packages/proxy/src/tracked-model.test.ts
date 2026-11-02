import { describe, expect, it } from "bun:test";
import {
	extractTrackedModelFromRequestBody,
	normalizeTrackedModel,
} from "./tracked-model";

describe("tracked model helpers", () => {
	it("trims tracked models and treats blank ones as absent", () => {
		expect(normalizeTrackedModel(" gpt-4o-mini ")).toBe("gpt-4o-mini");
		expect(normalizeTrackedModel("gpt-4o-mini")).toBe("gpt-4o-mini");
		expect(normalizeTrackedModel("   ")).toBeUndefined();
		expect(normalizeTrackedModel(42)).toBeUndefined();
	});

	it("keeps a native model id as sent, with no prefix stripping", () => {
		const encoded = Buffer.from(
			JSON.stringify({ model: "claude-opus-4.1" }),
		).toString("base64");

		expect(extractTrackedModelFromRequestBody(encoded)).toBe("claude-opus-4.1");
	});

	it("returns undefined for missing or unreadable bodies", () => {
		expect(extractTrackedModelFromRequestBody(null)).toBeUndefined();
		expect(
			extractTrackedModelFromRequestBody(
				Buffer.from(JSON.stringify({ input: "hi" })).toString("base64"),
			),
		).toBeUndefined();
	});
});
