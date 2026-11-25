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
		apiKeyAccounts: true,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	expect((await supply.availability(route)).capacity.state).toBe("available");
});

test("replacing settings during an open stream preserves and releases its permit", async () => {
	let active = 0;
	const request = requestFor([
		{ kind: "response", response: new Response("body") },
	]);
	request.ctx.runtime.teamRouting.enabled = true;
	request.ctx.teamAdmission = {
		acquire: async () => {
			active += 1;
			return {
				release: () => {
					active -= 1;
				},
			};
		},
	} as unknown as typeof request.ctx.teamAdmission;
	const outcome = await serveSelectedAccounts(request, [account], "direct");
	if (outcome.kind !== "final") throw new Error("expected final");
	expect(active).toBe(1);
	request.ctx.runtime.teamRouting = {
		...request.ctx.runtime.teamRouting,
		enabled: false,
	};
	expect(active).toBe(1);
	await outcome.response.text();
	expect(active).toBe(0);
});

test("websocket selection has no admission permit or in-flight count", async () => {
	const { ProviderSupply } = await import("./provider-supply");
	const provider = {
		name: "fake",
		wire: "openai-responses",
		quotaBucketsFor: () => undefined,
		isWeeklyBucket: () => false,
	} as unknown as import("@agent-smith/providers").Provider;
	const ctx = {
		runtime: {
			quotaThreshold: 0.98,
			blockWhenAllFull: true,
			teamRouting: { enabled: true },
		},
		strategy: { select: (accounts: Account[]) => accounts },
		dbOps: {
			getAvailableAccountsByProvider: () => [account],
			getAccountsByProvider: () => [account],
		},
		providerRegistry: {
			resolveProvider: () => ({ provider, upstreamPath: "/responses" }),
		},
		teamAdmission: {
			acquire: () => {
				throw new Error("unexpected permit");
			},
		},
		teamRouter: {
			order: (accounts: Account[]) => accounts,
			begin: () => {
				throw new Error("unexpected in-flight");
			},
		},
	} as unknown as import("./pool-context").PoolContext;
	const supply = new ProviderSupply(provider, ctx, {
		mapModel: (model) => model,
		createExecutor: () => async () => ({ kind: "failed" }),
		createSessionAttempt: async () => Object.freeze({}),
	});
	const url = new URL("http://localhost/v1/fake/responses");
	const route = {
		scope: { kind: "direct", provider: "fake" },
		edge: {
			method: "GET",
			url,
			headers: new Headers(),
			body: null,
			meta: { id: "r", method: "GET", path: url.pathname, timestamp: 0 },
		},
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	const result = await supply.openSession(route);
	expect(result.kind).toBe("prepared");
	if (result.kind !== "prepared") throw new Error("expected prepared session");
	const first = await result.session.next();
	expect(first?.attemptNumber).toBe(1);
	expect(first && Reflect.ownKeys(first.handle)).toEqual([]);
	expect(await result.session.next()).toBeNull();
});

test("caller status counts an API-key account when ordered fallback reaches it", async () => {
	const { ProviderSupply } = await import("./provider-supply");
	const provider = {
		name: "fake",
		wire: "anthropic-messages",
		quotaBucketsFor: () => undefined,
		isWeeklyBucket: () => false,
		isFiveHourBucket: () => false,
	} as unknown as import("@agent-smith/providers").Provider;
	const seat = { ...account, paused: false, auth_method: "api_key" } as Account;
	const ctx = {
		runtime: {
			quotaThreshold: 0.98,
			teamRouting: {
				enabled: true,
				allowlistedAccountUuids: [],
				maxUsage: 0.9,
				weeklyMaxUsage: 0.9,
				weeklyMaxUsageByEmail: {},
				callerWeeklyMaxUsage: {},
				admissionWaitMs: 100,
			},
		},
		dbOps: {
			getAccountsByProvider: () => [seat],
			getEnrollmentContact: () => null,
		},
		providerRegistry: { getProvider: () => provider },
	} as unknown as import("./pool-context").PoolContext;
	const supply = new ProviderSupply(provider, ctx, {
		mapModel: (model) => model,
		createExecutor: () => async () => ({ kind: "failed" }),
	});
	const url = new URL(
		"http://localhost/v1/pool/anthropic-messages/v1/messages",
	);
	const route = {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
		edge: {
			method: "GET",
			url,
			headers: new Headers(),
			body: null,
			meta: { id: "status", method: "GET", path: url.pathname, timestamp: 0 },
		},
		callerId: "device",
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: true,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	expect(await supply.status(route)).toEqual({
		servableSeats: 1,
		retryAt: null,
		admissionWaitMs: 100,
	});
});

test("a short per-minute limit retries the same seat once", async () => {
	const outcome = await serveSelectedAccounts(
		requestFor([
			{ kind: "per-minute-rate-limit", retryAfterMs: 0, forward },
			{ kind: "response", response: new Response("retry") },
		]),
		[account],
		"direct",
	);
	expect(outcome.kind).toBe("final");
	if (outcome.kind !== "final") throw new Error("expected final");
	expect(outcome.providerServed).toBe(false);
	expect(await outcome.response.text()).toBe("retry");
});

test("a long per-minute limit forwards without another attempt", async () => {
	const outcome = await serveSelectedAccounts(
		requestFor([
			{ kind: "per-minute-rate-limit", retryAfterMs: 60_001, forward },
		]),
		[account],
		"direct",
	);
	expect(outcome.kind).toBe("final");
	if (outcome.kind !== "final") throw new Error("expected final");
	expect(await outcome.response.text()).toBe("upstream");
});

test("availability checks the serving provider's mapped model buckets", async () => {
	const { ProviderSupply } = await import("./provider-supply");
	const now = Date.now();
	const provider = {
		name: "fake",
		wire: "anthropic-messages",
		quotaBucketsFor: (model: string | undefined) =>
			model === "native-model" ? ["native-5h"] : ["client-5h"],
		isWeeklyBucket: () => false,
		isFiveHourBucket: (bucket: string) => bucket === "native-5h",
	} as unknown as import("@agent-smith/providers").Provider;
	const blocked = {
		...account,
		paused: false,
		auth_method: "api_key",
		rate_limited_until: null,
		quota_state: {
			windows: {
				"native-5h": {
					status: "rejected",
					utilization: null,
					seenAt: now,
					resetAt: now + 60_000,
				},
			},
		},
	} as unknown as Account;
	const ctx = {
		runtime: { quotaThreshold: 0.98, teamRouting: { enabled: false } },
		dbOps: {
			getAvailableAccountsByProvider: () => [blocked],
			getAccountsByProvider: () => [blocked],
		},
		providerRegistry: { resolvePool: () => ({ upstreamPath: "/v1/messages" }) },
	} as unknown as import("./pool-context").PoolContext;
	const supply = new ProviderSupply(provider, ctx, {
		mapModel: () => "native-model",
		createExecutor: () => async () => ({ kind: "failed" }),
	});
	const url = new URL(
		"http://localhost/v1/pool/anthropic-messages/v1/messages",
	);
	const route = {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
		edge: {
			method: "POST",
			url,
			headers: new Headers(),
			body: null,
			meta: {
				id: "r",
				method: "POST",
				model: "client-model",
				path: url.pathname,
				timestamp: now,
			},
		},
		model: "client-model",
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	expect((await supply.availability(route)).capacity).toMatchObject({
		state: "blocked",
		block: { category: "five-hour-limit" },
	});
});

test.each([
	"manual",
	"thread",
] as const)("availability and no-eligible serve ignore quota blocks on a different seat for a %s-bound request", async (binding) => {
	const { ProviderSupply } = await import("./provider-supply");
	const now = Date.now();
	const provider = {
		name: "fake",
		wire: "anthropic-messages",
		quotaBucketsFor: () => undefined,
		isWeeklyBucket: () => false,
		isFiveHourBucket: () => true,
		getClientSessionId: (headers: Headers) => headers.get("x-session-id"),
	} as unknown as import("@agent-smith/providers").Provider;
	const cooling = {
		...account,
		id: "cooling",
		name: "wanted",
		auth_method: "oauth",
		account_uuid: "wanted-uuid",
		paused: false,
		rate_limited_until: now + 60_000,
	} as Account;
	const blocked = {
		...account,
		id: "blocked",
		name: "other",
		auth_method: "oauth",
		account_uuid: "other-uuid",
		paused: false,
		rate_limited_until: null,
		quota_state: {
			windows: {
				unified5h: {
					status: "rejected",
					utilization: null,
					seenAt: now,
					resetAt: now + 60_000,
				},
			},
		},
	} as unknown as Account;
	const ctx = {
		runtime: {
			quotaThreshold: 0.98,
			blockWhenAllFull: true,
			teamRouting: {
				enabled: true,
				allowlistedAccountUuids: ["wanted-uuid", "other-uuid"],
				maxUsage: 0.9,
				weeklyMaxUsage: 0.9,
				weeklyMaxUsageByEmail: {},
				callerWeeklyMaxUsage: {},
			},
		},
		strategy: { select: (seats: Account[]) => seats },
		dbOps: {
			getAvailableAccountsByProvider: () => [blocked],
			getAccountsByProvider: () => [cooling, blocked],
			getEnrollmentContact: () => null,
		},
		providerRegistry: {
			resolveProvider: () => ({ provider, upstreamPath: "/v1/messages" }),
		},
		teamRouter: {
			getPinnedAccountId: () => undefined,
			order: (seats: Account[]) => seats,
			eligibleAccounts: (
				seats: Account[],
				req: { manualAccountName?: string },
			) =>
				req.manualAccountName
					? seats.filter((seat) => seat.name === req.manualAccountName)
					: seats,
		},
		messageThreads: new Map([
			[
				"message",
				{ accountId: "cooling", sessionId: "session", expiresAt: now + 60_000 },
			],
		]),
	} as unknown as import("./pool-context").PoolContext;
	const supply = new ProviderSupply(provider, ctx, {
		mapModel: (model) => model,
		createExecutor: () => async () => ({ kind: "failed" }),
	});
	const url = new URL("http://localhost/v1/fake/v1/messages");
	const body =
		binding === "thread"
			? new TextEncoder().encode(
					'{"thread":{"type":"continue","previous_message_id":"message"}}',
				).buffer
			: null;
	const route = {
		scope: { kind: "direct", provider: "fake" },
		edge: {
			method: "POST",
			url,
			headers: new Headers({
				"content-type": "application/json",
				"x-session-id": "session",
			}),
			body,
			meta: { id: "r", method: "POST", path: url.pathname, timestamp: now },
		},
		seatHint: binding === "manual" ? "wanted" : undefined,
		sessionId: "session",
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	expect((await supply.availability(route)).capacity).toMatchObject({
		state: "blocked",
		block: { category: "unknown" },
	});
	expect(await supply.serve(route)).toMatchObject({
		kind: "exhausted",
		reason: "no-eligible-account",
	});
});

test("a failed response stream releases its permit", async () => {
	let released = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.error(new Error("stream failed"));
		},
	});
	const request = requestFor([
		{ kind: "response", response: new Response(body) },
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
	if (outcome.kind !== "final") throw new Error("expected final");
	await expect(outcome.response.text()).rejects.toThrow("stream failed");
	expect(released).toBe(1);
});

test("a provider does not execute an unsupported mapped model", async () => {
	const { ProviderSupply } = await import("./provider-supply");
	let executions = 0;
	const provider = {
		name: "fake",
		wire: "anthropic-messages",
	} as unknown as import("@agent-smith/providers").Provider;
	const supply = new ProviderSupply(
		provider,
		{} as import("./pool-context").PoolContext,
		{
			mapModel: () => null,
			createExecutor: () => async () => {
				executions += 1;
				return { kind: "failed" };
			},
		},
	);
	const url = new URL(
		"http://localhost/v1/pool/anthropic-messages/v1/messages",
	);
	const route = {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
		edge: {
			method: "POST",
			url,
			headers: new Headers(),
			body: null,
			meta: { id: "r", method: "POST", path: url.pathname, timestamp: 0 },
		},
		model: "unsupported",
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	expect(await supply.serve(route)).toMatchObject({
		kind: "exhausted",
		reason: "no-eligible-account",
	});
	expect(executions).toBe(0);
});

test("preparing and serving a route keeps selected accounts inside the pool and invokes the injected executor", async () => {
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
	let attempts = 0;
	const supply = new ProviderSupply(provider, ctx, {
		mapModel: (model) => model,
		createExecutor: () => async () => {
			attempts += 1;
			return { kind: "response", response: new Response("ok") };
		},
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
	const snapshot = await supply.availability(route);
	expect(snapshot.capacity.state).toBe("available");
	expect(JSON.stringify(snapshot)).not.toContain("seat-1");
	const result = await supply.serve(route);
	expect(result.kind).toBe("final");
	expect(attempts).toBe(1);
});

test("caller status maps the requested model exactly once", async () => {
	const { ProviderSupply } = await import("./provider-supply");
	const now = Date.now();
	const provider = {
		name: "fake",
		wire: "anthropic-messages",
		quotaBucketsFor: (model: string | undefined) =>
			model === "native" ? ["native-5h"] : ["other"],
		isWeeklyBucket: () => false,
		isFiveHourBucket: () => true,
	} as unknown as import("@agent-smith/providers").Provider;
	const blocked = {
		...account,
		paused: false,
		auth_method: "api_key",
		rate_limited_until: null,
		quota_state: {
			windows: {
				"native-5h": {
					status: "rejected",
					utilization: null,
					seenAt: now,
					resetAt: now + 60_000,
				},
			},
		},
	} as unknown as Account;
	const ctx = {
		runtime: {
			quotaThreshold: 0.98,
			teamRouting: {
				enabled: true,
				allowlistedAccountUuids: [],
				maxUsage: 0.9,
				weeklyMaxUsage: 0.9,
				weeklyMaxUsageByEmail: {},
				callerWeeklyMaxUsage: {},
				admissionWaitMs: 100,
			},
		},
		dbOps: {
			getAccountsByProvider: () => [blocked],
			getEnrollmentContact: () => null,
		},
		providerRegistry: { getProvider: () => provider },
	} as unknown as import("./pool-context").PoolContext;
	const supply = new ProviderSupply(provider, ctx, {
		mapModel: (model) => (model === "client" ? "native" : null),
		createExecutor: () => async () => ({ kind: "failed" }),
	});
	const url = new URL(
		"http://localhost/v1/pool/anthropic-messages/v1/messages",
	);
	const route = {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
		edge: {
			method: "GET",
			url,
			headers: new Headers(),
			body: null,
			meta: { id: "status", method: "GET", path: url.pathname, timestamp: now },
		},
		model: "client",
		callerId: "device",
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: true,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	expect(await supply.status(route)).toEqual({
		servableSeats: 0,
		retryAt: now + 60_000,
		admissionWaitMs: 100,
	});
});

test("a pooled thread uses the serving provider session parser while pins use the first provider session", async () => {
	const { ProviderSupply } = await import("./provider-supply");
	const now = Date.now();
	const provider = {
		name: "second",
		wire: "anthropic-messages",
		getClientSessionId: (headers: Headers) => headers.get("x-second-session"),
		quotaBucketsFor: () => undefined,
		isWeeklyBucket: () => false,
		isFiveHourBucket: () => true,
	} as unknown as import("@agent-smith/providers").Provider;
	const cooling = {
		...account,
		id: "thread-seat",
		paused: false,
		rate_limited_until: now + 60_000,
	} as Account;
	const blocked = {
		...account,
		id: "other",
		paused: false,
		rate_limited_until: null,
		quota_state: {
			windows: {
				unified5h: {
					status: "rejected",
					utilization: null,
					seenAt: now,
					resetAt: now + 60_000,
				},
			},
		},
	} as unknown as Account;
	const ctx = {
		runtime: {
			quotaThreshold: 0.98,
			blockWhenAllFull: true,
			teamRouting: { enabled: false },
		},
		strategy: { select: (accounts: Account[]) => accounts },
		dbOps: {
			getAvailableAccountsByProvider: () => [blocked],
			getAccountsByProvider: () => [cooling, blocked],
		},
		providerRegistry: { resolvePool: () => ({ upstreamPath: "/v1/messages" }) },
		messageThreads: new Map([
			[
				"msg",
				{
					accountId: "thread-seat",
					sessionId: "second-session",
					expiresAt: now + 60_000,
				},
			],
		]),
	} as unknown as import("./pool-context").PoolContext;
	const supply = new ProviderSupply(provider, ctx, {
		mapModel: (model) => model,
		createExecutor: () => async () => ({ kind: "failed" }),
	});
	const url = new URL(
		"http://localhost/v1/pool/anthropic-messages/v1/messages",
	);
	const body = new TextEncoder().encode(
		'{"thread":{"type":"continue","previous_message_id":"msg"}}',
	).buffer;
	const route = {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
		edge: {
			method: "POST",
			url,
			headers: new Headers({
				"content-type": "application/json",
				"x-second-session": "second-session",
			}),
			body,
			meta: { id: "r", method: "POST", path: url.pathname, timestamp: now },
		},
		sessionId: "first-session",
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	expect((await supply.availability(route)).capacity).toMatchObject({
		state: "blocked",
		block: { category: "unknown" },
	});
	expect(await supply.serve(route)).toMatchObject({
		kind: "exhausted",
		reason: "no-eligible-account",
	});
});

test("pool status without a caller maps its requested model", async () => {
	const { ProviderSupply } = await import("./provider-supply");
	const now = Date.now();
	const provider = {
		name: "fake",
		wire: "anthropic-messages",
		quotaBucketsFor: (model: string | undefined) =>
			model === "native" ? ["native-5h"] : ["other"],
		isWeeklyBucket: () => false,
		isFiveHourBucket: () => true,
	} as unknown as import("@agent-smith/providers").Provider;
	const blocked = {
		...account,
		paused: false,
		auth_method: "oauth",
		account_uuid: "seat",
		rate_limited_until: null,
		quota_state: {
			windows: {
				"native-5h": {
					status: "rejected",
					utilization: null,
					seenAt: now,
					resetAt: now + 60_000,
				},
			},
		},
	} as unknown as Account;
	const ctx = {
		runtime: {
			quotaThreshold: 0.98,
			teamRouting: {
				enabled: true,
				allowlistedAccountUuids: ["seat"],
				maxUsage: 0.9,
				weeklyMaxUsage: 0.9,
				weeklyMaxUsageByEmail: {},
				callerWeeklyMaxUsage: {},
				holdSeconds: 0,
				admissionWaitMs: 100,
			},
		},
		dbOps: {
			getAccountsByProvider: () => [blocked],
			getEnrollmentContact: () => null,
		},
		providerRegistry: { getProvider: () => provider },
	} as unknown as import("./pool-context").PoolContext;
	const supply = new ProviderSupply(provider, ctx, {
		mapModel: (model) => (model === "client" ? "native" : null),
		createExecutor: () => async () => ({ kind: "failed" }),
	});
	const url = new URL(
		"http://localhost/v1/pool/anthropic-messages/v1/messages",
	);
	const route = {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
		edge: {
			method: "GET",
			url,
			headers: new Headers(),
			body: null,
			meta: { id: "status", method: "GET", path: url.pathname, timestamp: now },
		},
		model: "client",
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	expect(await supply.status(route)).toEqual({
		servableSeats: 0,
		retryAt: now + 60_000,
		admissionWaitMs: 100,
	});
});

test("closing a websocket session during a failed refresh prevents trying the next seat", async () => {
	const { ProviderSupply } = await import("./provider-supply");
	const provider = {
		name: "fake",
		wire: "openai-responses",
		quotaBucketsFor: () => undefined,
		isWeeklyBucket: () => false,
	} as unknown as import("@agent-smith/providers").Provider;
	const seats = [account, { ...account, id: "seat-2" } as Account];
	const ctx = {
		runtime: {
			quotaThreshold: 0.98,
			blockWhenAllFull: true,
			teamRouting: { enabled: false },
		},
		strategy: { select: (accounts: Account[]) => accounts },
		dbOps: {
			getAvailableAccountsByProvider: () => seats,
			getAccountsByProvider: () => seats,
		},
		providerRegistry: {
			resolveProvider: () => ({ provider, upstreamPath: "/responses" }),
		},
	} as unknown as import("./pool-context").PoolContext;
	let calls = 0;
	let fail: ((error: Error) => void) | undefined;
	const supply = new ProviderSupply(provider, ctx, {
		mapModel: (model) => model,
		createExecutor: () => async () => ({ kind: "failed" }),
		createSessionAttempt: async () => {
			calls += 1;
			return await new Promise<object>((_resolve, reject) => {
				fail = reject;
			});
		},
	});
	const url = new URL("http://localhost/v1/fake/responses");
	const route = {
		scope: { kind: "direct", provider: "fake" },
		edge: {
			method: "GET",
			url,
			headers: new Headers(),
			body: null,
			meta: { id: "r", method: "GET", path: url.pathname, timestamp: 0 },
		},
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	} as const;
	const outcome = await supply.openSession(route);
	if (outcome.kind !== "prepared") throw new Error("expected session");
	const next = outcome.session.next();
	expect(calls).toBe(1);
	outcome.session.close();
	if (!fail) throw new Error("first refresh did not start");
	fail(new Error("refresh failed"));
	expect(await next).toBeNull();
	expect(calls).toBe(1);
});
