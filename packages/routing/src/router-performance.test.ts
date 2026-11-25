import { expect, it } from "bun:test";
import type { RoutedProvider, RouteRequest } from "@agent-smith/capacity";
import { type ConversationProviderRoutingStore, Router } from "./index";

it("does not query full capacity for an ordinary successful route", async () => {
	let checks = 0;
	let capacityQueries = 0;
	const provider = {
		name: "first",
		wire: "anthropic-messages",
		mapModel: (model: string) => model,
		conversationAffinity: async () => {
			checks++;
			return { holdsConversation: false, hasConversationPin: false };
		},
		availability: async () => {
			capacityQueries++;
			throw new Error("unexpected capacity scan");
		},
		serve: async () => ({
			kind: "final",
			providerServed: true,
			response: new Response("ok"),
		}),
	} as unknown as RoutedProvider;
	const route = {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
		edge: {},
		sessionId: null,
		apiKeyAccounts: false,
		signal: new AbortController().signal,
	} as unknown as RouteRequest;
	const response = await new Router(
		{} as ConversationProviderRoutingStore,
	).route({
		route,
		providers: [provider],
		headers: new Headers(),
		orderedFallback: false,
		apiKeyAccounts: "chooser_or_fallback" as const,
		noEligible: () => new Response("empty", { status: 503 }),
	});
	expect(await response.text()).toBe("ok");
	expect(checks).toBe(1);
	expect(capacityQueries).toBe(0);
});

it("reads missing capacity facts only when the route is exhausted", async () => {
	const resetAt = Date.now() + 60_000;
	let scans = 0;
	let reported = 0;
	const provider = {
		name: "first",
		wire: "anthropic-messages",
		mapModel: (model: string) => model,
		conversationAffinity: async () => ({
			holdsConversation: false,
			hasConversationPin: false,
		}),
		availability: async () => {
			scans++;
			return {
				capacity: {
					state: "blocked",
					block: { category: "request-rate", retryAt: resetAt },
					fleetFull: true,
					fleetResetAt: resetAt,
				},
				holdsConversation: false,
				threadRequest: false,
			};
		},
		serve: async () => ({ kind: "exhausted", reason: "no-eligible-account" }),
	} as unknown as RoutedProvider;
	const route = {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
		edge: {},
		sessionId: null,
		apiKeyAccounts: false,
		signal: new AbortController().signal,
	} as unknown as RouteRequest;
	const response = await new Router(
		{} as ConversationProviderRoutingStore,
	).route({
		route,
		providers: [provider],
		headers: new Headers(),
		orderedFallback: false,
		apiKeyAccounts: "chooser_or_fallback" as const,
		onRouteFull: (at) => {
			reported = at;
		},
		noEligible: () => new Response("empty", { status: 503 }),
	});
	expect(response.status).toBe(429);
	expect(scans).toBe(1);
	expect(reported).toBe(resetAt);
});

it("does not scan an exhausted provider when the next provider serves", async () => {
	let scans = 0;
	const first = {
		name: "first",
		wire: "anthropic-messages",
		mapModel: (model: string) => model,
		conversationAffinity: async () => ({
			holdsConversation: false,
			hasConversationPin: false,
		}),
		availability: async () => {
			scans++;
			throw new Error("unexpected capacity scan");
		},
		serve: async () => ({ kind: "exhausted", reason: "no-eligible-account" }),
	} as unknown as RoutedProvider;
	const second = {
		name: "second",
		wire: "anthropic-messages",
		mapModel: (model: string) => model,
		conversationAffinity: async () => ({
			holdsConversation: false,
			hasConversationPin: false,
		}),
		availability: async () => {
			scans++;
			throw new Error("unexpected capacity scan");
		},
		serve: async () => ({
			kind: "final",
			providerServed: true,
			response: new Response("ok"),
		}),
	} as unknown as RoutedProvider;
	const route = {
		scope: { kind: "pool-route", wire: "anthropic-messages" },
		edge: {},
		sessionId: null,
		apiKeyAccounts: false,
		signal: new AbortController().signal,
	} as unknown as RouteRequest;
	const response = await new Router(
		{} as ConversationProviderRoutingStore,
	).route({
		route,
		providers: [first, second],
		headers: new Headers(),
		orderedFallback: true,
		apiKeyAccounts: "chooser_or_fallback" as const,
		noEligible: () => new Response("empty", { status: 503 }),
	});
	expect(await response.text()).toBe("ok");
	expect(scans).toBe(0);
});
