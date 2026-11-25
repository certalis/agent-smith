import { expect, test } from "bun:test";
import type {
	RoutedProvider,
	RouteRequest,
	ServeOutcome,
} from "@agent-smith/capacity";
import {
	type ConversationProviderRoutingStore,
	getCallerPoolStatus,
	Router,
} from "./index";

type FakeBackend = { capacity(): number; serve(): ServeOutcome };
class FakeSeatPool implements FakeBackend {
	private readonly seats = ["synthetic-seat-a", "synthetic-seat-b"];
	blocked = false;
	attempts = 0;
	capacity() {
		return this.blocked ? 0 : this.seats.length;
	}
	serve(): ServeOutcome {
		this.attempts++;
		return this.blocked
			? {
					kind: "exhausted",
					reason: "no-eligible-account",
					fleetFull: true,
					retryAt: null,
					fleetResetAt: null,
				}
			: {
					kind: "final",
					providerServed: true,
					response: new Response("pooled response"),
				};
	}
}
class FakeSingleKey implements FakeBackend {
	attempts = 0;
	capacity() {
		return 1;
	}
	serve(): ServeOutcome {
		this.attempts++;
		return {
			kind: "final",
			providerServed: true,
			response: new Response("key response"),
		};
	}
}
function provider(name: string, backend: FakeBackend): RoutedProvider {
	return {
		name,
		wire: "anthropic-messages",
		mapModel: (model) => model,
		conversationAffinity: async () => ({
			holdsConversation: false,
			hasConversationPin: false,
		}),
		availability: async () => ({
			capacity: backend.capacity()
				? { state: "available" }
				: {
						state: "blocked",
						block: { category: "unknown" },
						fleetFull: true,
						fleetResetAt: null,
					},
			holdsConversation: false,
			threadRequest: false,
		}),
		status: async () => ({
			poolEnabled: true,
			servableSeats: backend.capacity(),
			retryAt: null,
			admissionWaitMs: 0,
		}),
		serve: async () => backend.serve(),
	};
}
function request(): RouteRequest {
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
			meta: { id: "r", method: "POST", path: url.pathname, timestamp: 0 },
		},
		model: "model",
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts: false,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	};
}
function fixture() {
	const pool = new FakeSeatPool();
	const key = new FakeSingleKey();
	const providers = [provider("pooled", pool), provider("key", key)];
	return {
		pool,
		key,
		providers,
		router: new Router({} as ConversationProviderRoutingStore),
	};
}

test("the same provider interface serves a pool first and a key after pool exhaustion", async () => {
	const { pool, key, providers, router } = fixture();
	const input = {
		providers,
		headers: new Headers(),
		orderedFallback: true,
		apiKeyAccounts: "chooser_or_fallback" as const,
		noEligible: () => new Response("unavailable", { status: 503 }),
	};
	const first = await router.route({ ...input, route: request() });
	expect(await first.text()).toBe("pooled response");
	expect([pool.attempts, key.attempts]).toEqual([1, 0]);
	pool.blocked = true;
	const second = await router.route({ ...input, route: request() });
	expect(await second.text()).toBe("key response");
	expect([pool.attempts, key.attempts]).toEqual([2, 1]);
});

test("a chooser can select the key provider while the pool is available", async () => {
	const { pool, key, providers, router } = fixture();
	const response = await router.route({
		route: request(),
		providers,
		headers: new Headers({
			"x-agent-smith-interactive-provider-choice": "v1",
			"x-agent-smith-provider-choice": "key",
		}),
		orderedFallback: false,
		apiKeyAccounts: "chooser_or_fallback" as const,
		noEligible: () => new Response("unavailable", { status: 503 }),
	});
	expect(await response.text()).toBe("key response");
	expect(response.headers.get("x-agent-smith-served-provider")).toBe("key");
	expect([pool.attempts, key.attempts]).toEqual([0, 1]);
});

test("caller status sums only the reachable fake providers' status", async () => {
	const { providers } = fixture();
	const input = {
		route: request(),
		providers,
		apiKeyAccounts: true,
		holdSeconds: 0,
	};
	expect(
		(await getCallerPoolStatus({ ...input, orderedFallback: false }))
			?.eligibleAccounts,
	).toBe(2);
	expect(
		(await getCallerPoolStatus({ ...input, orderedFallback: true }))
			?.eligibleAccounts,
	).toBe(3);
});
