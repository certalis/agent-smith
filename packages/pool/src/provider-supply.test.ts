import { describe, expect, test } from "bun:test";
import type { Account } from "@agent-smith/types";
import type { PoolAttemptRequest, ProxyAttempt } from "./attempt-executor";
import { serveSelectedAccounts } from "./provider-supply";

const account = { id: "seat-1" } as Account;
const forward = async () => new Response("upstream", { status: 429 });
const block = { category: "request-rate" } as const;

function requestFor(attempts: ProxyAttempt[]): PoolAttemptRequest {
	return {
		req: new Request("http://localhost/test"),
		ctx: {
			runtime: { teamRouting: { enabled: false } },
			provider: {},
			providerName: "fake",
		},
		execute: async () => {
			const attempt = attempts.shift();
			if (!attempt) throw new Error("Unexpected account attempt");
			return attempt;
		},
	} as unknown as PoolAttemptRequest;
}

describe("serving selected accounts", () => {
	test.each([
		[{ kind: "provider-capacity-block", block, forward }, "capacity-block"],
		[{ kind: "quota-rate-limit", forward }, "quota"],
		[{ kind: "upstream-failure", forward }, "upstream-failure"],
		[{ kind: "transport-failure" }, "transport"],
		[{ kind: "failed" }, "all-failed"],
	] satisfies Array<
		[ProxyAttempt, string]
	>)("returns exhausted for a terminal %o", async (attempt, reason) => {
		const outcome = await serveSelectedAccounts(
			requestFor([attempt]),
			[account],
			"direct",
		);
		expect(outcome.kind).toBe("exhausted");
		if (outcome.kind !== "exhausted") throw new Error("expected exhaustion");
		expect(outcome.reason).toBe(reason);
	});

	test("reports a first-hand response as provider served", async () => {
		const outcome = await serveSelectedAccounts(
			requestFor([{ kind: "response", response: new Response("ok") }]),
			[account],
			"pool-route",
		);
		expect(outcome.kind).toBe("final");
		if (outcome.kind !== "final") throw new Error("expected final response");
		expect(outcome.providerServed).toBe(true);
	});

	test("reports an empty selection as no eligible account", async () => {
		const outcome = await serveSelectedAccounts(requestFor([]), [], "direct");
		expect(outcome).toMatchObject({
			kind: "exhausted",
			reason: "no-eligible-account",
		});
	});
});

test("a pooled capacity block discards its first response and tries the next seat", async () => {
	let discarded = 0;
	const second = { id: "seat-2" } as Account;
	const request = requestFor([
		{
			kind: "provider-capacity-block",
			block,
			forward,
			discard: async () => {
				discarded += 1;
			},
		},
		{ kind: "response", response: new Response("second") },
	]);
	const outcome = await serveSelectedAccounts(
		request,
		[account, second],
		"pool-route",
	);
	expect(discarded).toBe(1);
	expect(outcome.kind).toBe("final");
	if (outcome.kind !== "final") throw new Error("expected final");
	expect(outcome.providerServed).toBe(true);
	expect(await outcome.response.text()).toBe("second");
});

test("a sibling-resolved quota failure is final without reporting a first-hand answer", async () => {
	const second = { id: "seat-2" } as Account;
	const request = requestFor([
		{ kind: "quota-rate-limit", forward },
		{ kind: "response", response: new Response("sibling") },
	]);
	const outcome = await serveSelectedAccounts(
		request,
		[account, second],
		"pool-route",
	);
	expect(outcome.kind).toBe("final");
	if (outcome.kind !== "final") throw new Error("expected final");
	expect(outcome.providerServed).toBe(false);
	expect(await outcome.response.text()).toBe("sibling");
});

test.each([
	"end",
	"cancel",
] as const)("a final response releases its admission permit on %s", async (finish) => {
	let released = 0;
	const request = requestFor([
		{ kind: "response", response: new Response("body") },
	]);
	request.ctx.runtime.teamRouting.enabled = true;
	request.ctx.teamAdmission = {
		acquire: async () => ({
			release: () => {
				released += 1;
			},
		}),
	} as unknown as typeof request.ctx.teamAdmission;
	const outcome = await serveSelectedAccounts(request, [account], "direct");
	expect(outcome.kind).toBe("final");
	if (outcome.kind !== "final") throw new Error("expected final");
	expect(released).toBe(0);
	if (finish === "end") await outcome.response.text();
	else await outcome.response.body?.cancel();
	expect(released).toBe(1);
});

test("an exhausted attempt releases its admission permit", async () => {
	let released = 0;
	const request = requestFor([{ kind: "quota-rate-limit", forward }]);
	request.ctx.runtime.teamRouting.enabled = true;
	request.ctx.teamAdmission = {
		acquire: async () => ({
			release: () => {
				released += 1;
			},
		}),
	} as unknown as typeof request.ctx.teamAdmission;
	const outcome = await serveSelectedAccounts(request, [account], "direct");
	expect(outcome.kind).toBe("exhausted");
	expect(released).toBe(1);
});
