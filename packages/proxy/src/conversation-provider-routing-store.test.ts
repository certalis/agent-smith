import { expect, test } from "bun:test";
import { SqliteConversationProviderRoutingStore } from "./conversation-provider-routing-store";

test("adapts database provider state to routing without leaking SQL into policy", () => {
	const writes: unknown[][] = [];
	const store = new SqliteConversationProviderRoutingStore({
		deleteConversationProviderBlock() {},
		getConversationProviderBlock() {
			return {
				category: "not-a-known-category",
				lastSeenAt: 5,
				retryAt: 10,
			};
		},
		getConversationProviderPreference() {
			return { lastSeenAt: 1, promotionDeclined: false, provider: "kimi" };
		},
		upsertConversationProviderBlock(...args: unknown[]) {
			writes.push(args);
		},
		upsertConversationProviderPreference() {},
	} as never);

	store.upsertBlock("chat", "qwen", {
		category: "request-rate",
		lastSeenAt: 20,
		retryAt: 30,
	});

	expect(store.getPreference("chat")).toEqual({
		lastSeenAt: 1,
		promotionDeclined: false,
		provider: "kimi",
	});
	expect(store.getBlock("chat", "qwen")).toEqual({
		category: "unknown",
		lastSeenAt: 5,
		retryAt: 10,
	});
	expect(writes).toEqual([["chat", "qwen", "request-rate", 30, 20]]);
});
