import { expect, test } from "bun:test";
import type { Account } from "@agent-smith/types";
import { applyAccountFact } from "./account-facts";
import type { ResolvedPoolContext } from "./pool-context";

test("a cooldown fact updates the live seat immediately and queues persistence", () => {
	const account = { id: "seat-1", rate_limited_until: null } as Account;
	const jobs: Array<() => void> = [];
	const writes: Array<[string, number]> = [];
	const ctx = {
		asyncWriter: { enqueue: (job: () => void) => jobs.push(job) },
		dbOps: {
			markAccountRateLimited: (id: string, until: number) =>
				writes.push([id, until]),
		},
	} as unknown as ResolvedPoolContext;
	applyAccountFact(account, ctx, { kind: "cooldown", until: 1234 });
	expect(account.rate_limited_until).toBe(1234);
	expect(writes).toEqual([]);
	for (const job of jobs) job();
	expect(writes).toEqual([["seat-1", 1234]]);
});
