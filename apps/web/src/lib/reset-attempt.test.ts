import { describe, expect, it } from "bun:test";
import {
	beginResetAttempt,
	completeResetAttempt,
	loadResetAttempt,
} from "./reset-attempt";

function storage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	};
}

describe("manual reset confirmation identity", () => {
	it("keeps the same attempt across reloads and refuses a second grant until its result is known", () => {
		const saved = storage();
		const first = beginResetAttempt(saved, "seat-a", "credit-one");
		expect(loadResetAttempt(saved, "seat-a")).toEqual(first);
		expect(beginResetAttempt(saved, "seat-a", "credit-one")).toEqual(first);
		expect(() => beginResetAttempt(saved, "seat-a", "credit-two")).toThrow(
			"Resolve the pending reset first",
		);
		expect(beginResetAttempt(saved, "seat-b", "credit-two").creditId).toBe(
			"credit-two",
		);
		completeResetAttempt(saved, "seat-a");
		expect(loadResetAttempt(saved, "seat-a")).toBeNull();
		expect(beginResetAttempt(saved, "seat-a", "credit-two").requestId).not.toBe(
			first.requestId,
		);
	});

	it("fails closed when the pending attempt cannot be saved", () => {
		const saved = {
			...storage(),
			setItem: () => {
				throw new Error("storage unavailable");
			},
		};
		expect(() => beginResetAttempt(saved, "seat-a", "credit-one")).toThrow(
			"storage unavailable",
		);
	});
});
