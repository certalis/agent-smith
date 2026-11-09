import { expect, test } from "bun:test";
import { stopAll } from "./cleanup";

test("stops every resource even when synchronous and asynchronous shutdowns fail", async () => {
	const calls: string[] = [];
	const syncFailure = new Error("synthetic synchronous shutdown failure");
	const asyncFailure = new Error("synthetic asynchronous shutdown failure");
	let failure: unknown;
	try {
		await stopAll([
			{
				stop() {
					calls.push("first");
					throw syncFailure;
				},
			},
			undefined,
			{
				async stop() {
					calls.push("second");
					throw asyncFailure;
				},
			},
			{
				stop() {
					calls.push("last");
				},
			},
		]);
	} catch (error) {
		failure = error;
	}
	expect(calls).toEqual(["first", "second", "last"]);
	expect(failure).toBeInstanceOf(AggregateError);
	expect((failure as AggregateError).errors).toEqual([
		syncFailure,
		asyncFailure,
	]);
});
