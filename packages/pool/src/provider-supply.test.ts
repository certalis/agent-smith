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
		[
			ProxyAttempt,
			Extract<
				import("@agent-smith/capacity").ServeOutcome,
				{ kind: "exhausted" }
			>["reason"],
		]
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

test("a direct capacity block leaves the upstream response available to forward", async () => {
	let discarded = 0;
	const outcome = await serveSelectedAccounts(
		requestFor([
			{
				kind: "provider-capacity-block",
				block,
				forward,
				discard: async () => {
					discarded += 1;
				},
			},
		]),
		[account],
		"direct",
	);
	expect(outcome.kind).toBe("exhausted");
	if (outcome.kind !== "exhausted") throw new Error("expected exhausted");
	expect(discarded).toBe(0);
	expect(await (await outcome.forward?.())?.text()).toBe("upstream");
});

test("an authentication failure is a final 502", async () => {
	const outcome = await serveSelectedAccounts(
		requestFor([{ kind: "authentication-failure" }]),
		[account],
		"direct",
	);
	expect(outcome.kind).toBe("final");
	if (outcome.kind !== "final") throw new Error("expected final");
	expect(outcome.response.status).toBe(502);
	expect(outcome.providerServed).toBe(false);
});

test("a request-scoped rate limit without a sibling is forwarded as final", async () => {
	const outcome = await serveSelectedAccounts(
		requestFor([{ kind: "request-scoped-rate-limit", forward }]),
		[account],
		"direct",
	);
	expect(outcome.kind).toBe("final");
	if (outcome.kind !== "final") throw new Error("expected final");
	expect(await outcome.response.text()).toBe("upstream");
	expect(outcome.providerServed).toBe(false);
});

test("a provider object selects and serves its own available account", async () => {
	const { ProviderSupply } = await import("./provider-supply");
	const provider = {
		name: "fake",
		wire: "anthropic-messages",
		quotaBucketsFor: () => undefined,
		isWeeklyBucket: () => false,
	} as unknown as import("@agent-smith/providers").Provider;
	const ctx = {
		runtime: {
			quotaThreshold: 0.98,
			blockWhenAllFull: true,
			teamRouting: { enabled: false },
		},
		strategy: { select: (accounts: Account[]) => accounts },
		dbOps: {
			getAvailableAccountsByProvider: () => [account],
			getAccountsByProvider: () => [account],
		},
		providerRegistry: {
			resolveProvider: () => ({ provider, upstreamPath: "/v1/messages" }),
		},
	} as unknown as import("./pool-context").PoolContext;
	const supply = new ProviderSupply(provider, ctx, {
		mapModel: (model) => model,
		createExecutor: () => async () => ({
			kind: "response",
			response: new Response("ok"),
		}),
	});
	const url = new URL("http://localhost/v1/fake/v1/messages");
	const route = {
		scope: { kind: "direct", provider: "fake" },
		edge: {
			method: "POST",
			url,
			headers: new Headers(),
			body: null,
			meta: { id: "r", method: "POST", path: url.pathname, timestamp: 0 },
		},
		model: "example",
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	const result = await supply.serve(route);
	expect(result.kind).toBe("final");
	if (result.kind !== "final") throw new Error("expected final");
	expect(result.providerServed).toBe(true);
	expect(await result.response.text()).toBe("ok");
});

test("a provider without a team pool reports a usable direct account", async () => {
	const { ProviderSupply } = await import("./provider-supply");
	const provider = {
		name: "fake",
		wire: "anthropic-messages",
		quotaBucketsFor: () => undefined,
		isWeeklyBucket: () => false,
	} as unknown as import("@agent-smith/providers").Provider;
	const seat = { ...account, paused: false, auth_method: "api_key" } as Account;
	const ctx = {
		runtime: {
			quotaThreshold: 0.98,
			teamRouting: { enabled: false, holdSeconds: 0, admissionWaitMs: 0 },
		},
		dbOps: {
			getAvailableAccountsByProvider: () => [seat],
			getAccountsByProvider: () => [seat],
		},
		providerRegistry: {
			getProvider: () => provider,
			resolveProvider: () => ({ provider, upstreamPath: "/v1/messages" }),
		},
	} as unknown as import("./pool-context").PoolContext;
	const supply = new ProviderSupply(provider, ctx, {
		mapModel: (model) => model,
		createExecutor: () => async () => ({ kind: "failed" }),
	});
	const url = new URL("http://localhost/v1/fake/v1/messages");
	const route = {
		scope: { kind: "direct", provider: "fake" },
		edge: {
			method: "POST",
			url,
			headers: new Headers(),
			body: null,
			meta: { id: "r", method: "POST", path: url.pathname, timestamp: 0 },
		},
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	expect((await supply.availability(route)).capacity.state).toBe("available");
});
