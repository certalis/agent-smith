import { expect, test } from "bun:test";
import type { RoutedProvider, RouteRequest } from "@agent-smith/capacity";
import {
	type ConversationProviderRoutingStore,
	getCallerPoolStatus,
	Router,
} from "./index";

test("ordered routing tries the next provider only after discarding the first failure", async () => {
	const events: string[] = [];
	const provider = (name: string, outcome: unknown) => ({
		name,
		wire: "anthropic-messages",
		mapModel: (model: string) => model,
		conversationAffinity: async () => ({
			holdsConversation: false,
			hasConversationPin: false,
		}),
		availability: async () => ({
			capacity: { state: "available" },
			holdsConversation: false,
			threadRequest: false,
		}),
		status: async () => ({
			servableSeats: 1,
			retryAt: null,
			admissionWaitMs: 0,
		}),
		serve: async () => {
			events.push(`serve ${name}`);
			return outcome;
		},
	});
	const first = provider("first", {
		kind: "exhausted",
		reason: "upstream-failure",
		discard: async () => {
			events.push("discard first");
		},
	});
	const second = provider("second", {
		kind: "final",
		providerServed: true,
		response: new Response("second"),
	});
	const router = new Router({} as ConversationProviderRoutingStore);
	const route = {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
		model: "model",
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
		edge: { headers: new Headers(), meta: {} },
	};
	const response = await router.route({
		route: route as unknown as RouteRequest,
		providers: [first, second] as unknown as RoutedProvider[],
		headers: new Headers(),
		orderedFallback: true,
		teamRoutingEnabled: true,
		noEligible: () => new Response("unavailable", { status: 503 }),
	});
	expect(await response.text()).toBe("second");
	expect(events).toEqual(["serve first", "discard first", "serve second"]);
});

test("caller status counts only the first provider unless fallback is allowed", async () => {
	const seen: string[] = [];
	const providers = ["first", "second"].map((name, index) => ({
		name,
		status: async () => {
			seen.push(name);
			return { servableSeats: index + 1, retryAt: null, admissionWaitMs: 0 };
		},
	})) as unknown as RoutedProvider[];
	const route = {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
	} as RouteRequest;
	const base = {
		route,
		providers,
		teamRoutingEnabled: true,
		holdSeconds: 0,
		admissionWaitMs: 0,
	};
	expect(
		(await getCallerPoolStatus({ ...base, orderedFallback: false }))
			?.eligibleAccounts,
	).toBe(1);
	expect(seen).toEqual(["first"]);
	seen.length = 0;
	expect(
		(await getCallerPoolStatus({ ...base, orderedFallback: true }))
			?.eligibleAccounts,
	).toBe(3);
	expect(seen).toEqual(["first", "second"]);
});

type Fixture = {
	provider: RoutedProvider;
	served: number;
	discarded: number;
	seen: RouteRequest[];
};
function fakeProvider(
	name: string,
	outcomes: import("@agent-smith/capacity").ServeOutcome[],
	options: {
		holdsConversation?: boolean;
		threadRequest?: boolean;
		blocked?: boolean;
		resetAt?: number;
	} = {},
): Fixture {
	const fixture = { served: 0, discarded: 0, seen: [] } as unknown as Fixture;
	fixture.provider = {
		name,
		wire: "anthropic-messages",
		mapModel: (model) => model,
		conversationAffinity: async (request) => {
			fixture.seen.push(request);
			return {
				holdsConversation: options.holdsConversation ?? false,
				hasConversationPin: options.holdsConversation ?? false,
			};
		},
		availability: async (request) => {
			fixture.seen.push(request);
			return {
				capacity: options.blocked
					? {
							state: "blocked",
							block: { category: "request-rate", retryAt: options.resetAt },
							fleetFull: true,
							fleetResetAt: options.resetAt ?? null,
						}
					: { state: "available" },
				holdsConversation: options.holdsConversation ?? false,
				threadRequest: options.threadRequest ?? false,
			};
		},
		status: async () => ({
			servableSeats: 1,
			retryAt: null,
			admissionWaitMs: 0,
		}),
		serve: async (request) => {
			fixture.seen.push(request);
			const outcome = outcomes[Math.min(fixture.served, outcomes.length - 1)];
			fixture.served++;
			if (!outcome) throw new Error("Missing fake provider outcome");
			if (outcome.kind === "exhausted" && outcome.discard)
				return {
					retryAt: options.resetAt ?? null,
					fleetFull: options.blocked ?? false,
					fleetResetAt: options.resetAt ?? null,
					...outcome,
					discard: async () => {
						fixture.discarded++;
						await outcome.discard?.();
					},
				};
			return outcome.kind === "exhausted"
				? {
						retryAt: options.resetAt ?? null,
						fleetFull: options.blocked ?? false,
						fleetResetAt: options.resetAt ?? null,
						...outcome,
					}
				: outcome;
		},
	};
	return fixture;
}
function routeFixture(): RouteRequest {
	const url = new URL(
		"http://localhost/v1/pool/anthropic-messages/v1/messages",
	);
	return {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
		edge: {
			url,
			method: "POST",
			headers: new Headers(),
			body: null,
			meta: { id: "test", method: "POST", path: url.pathname, timestamp: 0 },
		},
		model: "model",
		sessionId: "session",
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	};
}
function memoryStore() {
	const preferences = new Map<
		string,
		import("./index").ConversationProviderPreference
	>();
	const blocks = new Map<string, import("./index").ConversationProviderBlock>();
	const store: ConversationProviderRoutingStore = {
		getPreference: (key) => preferences.get(key) ?? null,
		upsertPreference: (key, value) => {
			preferences.set(key, value);
		},
		getBlock: (key, provider) => blocks.get(`${key}:${provider}`) ?? null,
		upsertBlock: (key, provider, value) => {
			blocks.set(`${key}:${provider}`, value);
		},
		deleteBlock: (key, provider) => {
			blocks.delete(`${key}:${provider}`);
		},
	};
	return { store, preferences, blocks };
}
const ok = () => ({
	kind: "final" as const,
	response: new Response("served"),
	providerServed: true,
});

test("a normal caller forwards the first failure without reaching another provider", async () => {
	const first = fakeProvider("first", [
		{
			kind: "exhausted",
			reason: "quota",
			forward: async () => new Response("limited", { status: 429 }),
		},
	]);
	const second = fakeProvider("second", [ok()]);
	const router = new Router(memoryStore().store);
	const response = await router.route({
		route: routeFixture(),
		providers: [first.provider, second.provider],
		headers: new Headers(),
		orderedFallback: false,
		teamRoutingEnabled: true,
		noEligible: () => new Response("empty", { status: 503 }),
	});
	expect(response.status).toBe(429);
	expect(await response.text()).toBe("limited");
	expect(second.served).toBe(0);
});

test("a pinned conversation chooses its provider and uses one route object", async () => {
	const first = fakeProvider("first", [ok()]);
	const pinned = fakeProvider("pinned", [ok()], { holdsConversation: true });
	const route = routeFixture();
	const router = new Router(memoryStore().store);
	const result = await router.route({
		route,
		providers: [first.provider, pinned.provider],
		headers: new Headers(),
		orderedFallback: false,
		teamRoutingEnabled: true,
		noEligible: () => new Response("empty", { status: 503 }),
	});
	expect(await result.text()).toBe("served");
	expect(first.served).toBe(0);
	expect(pinned.served).toBe(1);
	expect([...first.seen, ...pinned.seen].every((item) => item === route)).toBe(
		true,
	);
});

test("chooser records a pick only after that provider actually serves", async () => {
	const memory = memoryStore();
	const first = fakeProvider("first", [
		{
			kind: "final",
			providerServed: false,
			response: new Response("error", { status: 502 }),
		},
		ok(),
	]);
	const router = new Router(memory.store);
	const headers = new Headers({
		"x-agent-smith-interactive-provider-choice": "v1",
		"x-agent-smith-provider-choice": "first",
	});
	const input = {
		route: routeFixture(),
		providers: [first.provider],
		headers,
		orderedFallback: false,
		teamRoutingEnabled: true,
		conversationKey: "conversation",
		noEligible: () => new Response("empty", { status: 503 }),
	};
	await router.route(input);
	expect(memory.preferences.has("conversation")).toBe(false);
	await router.route(input);
	expect(memory.preferences.get("conversation")?.provider).toBe("first");
});

test("a thread-bound provider is excluded from the chooser", async () => {
	const first = fakeProvider("first", [
		{
			kind: "exhausted",
			reason: "capacity-block",
			block: { category: "request-rate" },
			discard: async () => {},
		},
	]);
	const thread = fakeProvider("thread", [ok()], { threadRequest: true });
	const available = fakeProvider("available", [ok()]);
	const router = new Router(memoryStore().store);
	const response = await router.route({
		route: routeFixture(),
		providers: [first.provider, thread.provider, available.provider],
		headers: new Headers({ "x-agent-smith-interactive-provider-choice": "v1" }),
		orderedFallback: false,
		teamRoutingEnabled: true,
		noEligible: () => new Response("empty", { status: 503 }),
	});
	const problem = (await response.json()) as {
		choices: { provider: string }[];
	};
	expect(problem.choices.map((choice) => choice.provider)).toEqual([
		"available",
	]);
	expect(first.discarded).toBe(1);
});

test("a provider with unknown capacity is offered as a choice", async () => {
	const first = fakeProvider("first", [
		{
			kind: "exhausted",
			reason: "capacity-block",
			block: { category: "request-rate" },
			discard: async () => {},
		},
	]);
	const unknown = fakeProvider("unknown", [ok()]);
	unknown.provider.availability = async () => ({
		capacity: { state: "unknown" },
		holdsConversation: false,
		threadRequest: false,
	});
	const router = new Router(memoryStore().store);
	const response = await router.route({
		route: routeFixture(),
		providers: [first.provider, unknown.provider],
		headers: new Headers({ "x-agent-smith-interactive-provider-choice": "v1" }),
		orderedFallback: false,
		teamRoutingEnabled: true,
		noEligible: () => new Response("empty", { status: 503 }),
	});
	const problem = (await response.json()) as {
		choices: { provider: string }[];
	};
	expect(problem.choices.map((choice) => choice.provider)).toEqual(["unknown"]);
});

test("an interactive wait retries once with the same request", async () => {
	const memory = memoryStore();
	const retryAt = Date.now() + 5000;
	memory.blocks.set("conversation:first", {
		category: "request-rate",
		retryAt,
		lastSeenAt: Date.now(),
	});
	const first = fakeProvider("first", [ok()]);
	const route = routeFixture();
	let waits = 0;
	const router = new Router(memory.store);
	const response = await router.route({
		route,
		providers: [first.provider],
		headers: new Headers({
			"x-agent-smith-interactive-provider-choice": "v1",
			"x-agent-smith-provider-wait": "v1",
		}),
		orderedFallback: false,
		teamRoutingEnabled: true,
		conversationKey: "conversation",
		holdSeconds: 10,
		waitUntil: async (_, signal) => {
			expect(signal).toBe(route.signal);
			waits++;
		},
		noEligible: () => new Response("empty", { status: 503 }),
	});
	expect(response.status).toBe(200);
	expect(waits).toBe(1);
	expect(first.served).toBe(1);
	expect(first.seen.every((item) => item === route)).toBe(true);
});

test("a capacity block is stored and cleared after a successful retry", async () => {
	const memory = memoryStore();
	const first = fakeProvider("first", [
		{
			kind: "exhausted",
			reason: "capacity-block",
			block: { category: "request-rate" },
			discard: async () => {},
		},
		ok(),
	]);
	const router = new Router(memory.store);
	const input = {
		route: routeFixture(),
		providers: [first.provider],
		headers: new Headers({ "x-agent-smith-interactive-provider-choice": "v1" }),
		orderedFallback: false,
		teamRoutingEnabled: true,
		conversationKey: "conversation",
		noEligible: () => new Response("empty", { status: 503 }),
	};
	expect((await router.route(input)).status).toBe(429);
	expect(memory.blocks.get("conversation:first")?.category).toBe(
		"request-rate",
	);
	expect((await router.route(input)).status).toBe(200);
	expect(memory.blocks.has("conversation:first")).toBe(false);
});

test("reports a full route and returns the soonest reset", async () => {
	const reset = Date.now() + 60000;
	const first = fakeProvider(
		"first",
		[{ kind: "exhausted", reason: "no-eligible-account" }],
		{ blocked: true, resetAt: reset },
	);
	const second = fakeProvider(
		"second",
		[{ kind: "exhausted", reason: "no-eligible-account" }],
		{ blocked: true, resetAt: reset + 1000 },
	);
	let reported = 0;
	const router = new Router(memoryStore().store);
	const response = await router.route({
		route: routeFixture(),
		providers: [first.provider, second.provider],
		headers: new Headers(),
		orderedFallback: true,
		teamRoutingEnabled: true,
		onRouteFull: (at) => {
			reported = at;
		},
		noEligible: () => new Response("empty", { status: 503 }),
	});
	expect(response.status).toBe(429);
	expect(response.headers.get("retry-after")).not.toBeNull();
	expect(reported).toBe(reset);
});

test("an aborted wait does not call a provider", async () => {
	const memory = memoryStore();
	memory.blocks.set("conversation:first", {
		category: "request-rate",
		retryAt: Date.now() + 5000,
		lastSeenAt: Date.now(),
	});
	const first = fakeProvider("first", [ok()]);
	const router = new Router(memory.store);
	await expect(
		router.route({
			route: routeFixture(),
			providers: [first.provider],
			headers: new Headers({
				"x-agent-smith-interactive-provider-choice": "v1",
				"x-agent-smith-provider-wait": "v1",
			}),
			orderedFallback: false,
			teamRoutingEnabled: true,
			conversationKey: "conversation",
			holdSeconds: 10,
			waitUntil: async () => {
				throw new Error("aborted");
			},
			noEligible: () => new Response("empty", { status: 503 }),
		}),
	).rejects.toThrow("aborted");
	expect(first.served).toBe(0);
});

test("a manual menu lists available providers without serving", async () => {
	const first = fakeProvider("first", [ok()]);
	const second = fakeProvider("second", [ok()]);
	const router = new Router(memoryStore().store);
	const response = await router.route({
		route: routeFixture(),
		providers: [first.provider, second.provider],
		headers: new Headers({
			"x-agent-smith-interactive-provider-choice": "v1",
			"x-agent-smith-provider-menu": "v1",
		}),
		orderedFallback: false,
		teamRoutingEnabled: true,
		noEligible: () => new Response("empty", { status: 503 }),
	});
	const menu = (await response.json()) as { choices: { provider: string }[] };
	expect(response.status).toBe(409);
	expect(menu.choices.map((choice) => choice.provider)).toEqual([
		"first",
		"second",
	]);
	expect(first.served + second.served).toBe(0);
});

test("a provider with no known recovery time does not invent one from a quota block", async () => {
	const retryAt = Date.now() + 60000;
	const first = fakeProvider(
		"first",
		[
			{
				kind: "exhausted",
				reason: "no-eligible-account",
				block: { category: "request-rate", retryAt },
				retryAt: null,
				fleetFull: false,
				fleetResetAt: null,
			},
		],
		{ blocked: true, resetAt: retryAt },
	);
	const router = new Router(memoryStore().store);
	const response = await router.route({
		route: routeFixture(),
		providers: [first.provider],
		headers: new Headers(),
		orderedFallback: false,
		teamRoutingEnabled: true,
		noEligible: () => new Response("empty", { status: 503 }),
	});
	expect(response.status).toBe(503);
});

test("an upstream failure does not persist a quota observation as a conversation block", async () => {
	const memory = memoryStore();
	const first = fakeProvider("first", [
		{
			kind: "exhausted",
			reason: "upstream-failure",
			block: { category: "request-rate" },
			discard: async () => {},
		},
	]);
	const second = fakeProvider("second", [ok()]);
	const router = new Router(memory.store);
	const response = await router.route({
		route: routeFixture(),
		providers: [first.provider, second.provider],
		headers: new Headers(),
		orderedFallback: true,
		teamRoutingEnabled: true,
		conversationKey: "conversation",
		noEligible: () => new Response("empty", { status: 503 }),
	});
	expect(response.status).toBe(200);
	expect(memory.blocks.has("conversation:first")).toBe(false);
});

test("ordered fallback starts from the first provider when an old pin is outside the route", async () => {
	const memory = memoryStore();
	memory.preferences.set("conversation", {
		provider: "second",
		promotionDeclined: false,
		lastSeenAt: Date.now(),
	});
	const first = fakeProvider("first", [ok()]);
	const second = fakeProvider("second", [ok()]);
	for (const candidate of [first, second])
		candidate.provider.conversationAffinity = async () => ({
			holdsConversation: false,
			hasConversationPin: true,
		});
	const router = new Router(memory.store);
	const response = await router.route({
		route: routeFixture(),
		providers: [first.provider, second.provider],
		headers: new Headers(),
		orderedFallback: true,
		teamRoutingEnabled: true,
		conversationKey: "conversation",
		noEligible: () => new Response("empty", { status: 503 }),
	});
	expect(response.status).toBe(200);
	expect(first.served).toBe(1);
	expect(second.served).toBe(0);
});
