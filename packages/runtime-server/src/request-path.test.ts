import { describe, expect, it } from "bun:test";
import { hasDotSegment } from "./request-path";

describe("hasDotSegment", () => {
	it("catches literal, encoded, and backslash traversal", () => {
		for (const path of [
			"/v1/messages/../api",
			"/v1/messages/%2e%2e/api",
			"/v1/messages/..%2f..%2fapi",
			"/v1/messages/.%5ccount",
		]) {
			expect(hasDotSegment(path)).toBe(true);
		}
	});

	it("does not confuse ordinary dots or double encoding with traversal", () => {
		for (const path of [
			"/v1/messages",
			"/api/files/a.b.c",
			"/v1/%252e%252e/messages",
		]) {
			expect(hasDotSegment(path)).toBe(false);
		}
	});
});
