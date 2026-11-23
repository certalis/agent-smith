import { expect, test } from "bun:test";
import { ConversationProviderRouting } from "./index";

test("keeps provider preference and upstream block state behind a routing store", () => {
	const preferences = new Map();
	const blocks = new Map();
	const routing = new ConversationProviderRouting({
		deleteBlock(key, provider) {
			blocks.delete(`${key}\u0000${provider}`);
		},
		getBlock(key, provider) {
			return blocks.get(`${key}\u0000${provider}`) ?? null;
		},
		getPreference(key) {
			return preferences.get(key) ?? null;
		},
		upsertBlock(key, provider, block) {
			blocks.set(`${key}\u0000${provider}`, block);
		},
		upsertPreference(key, preference) {
			preferences.set(key, preference);
		},
	});

	routing.selectProvider("chat", "kimi-claude", 10);
	routing.declinePromotion("chat", 11);
	routing.recordBlock(
		"chat",
		"qwen-claude",
		{ category: "dynamic-throughput" },
		12,
	);

	expect(routing.getPreference("chat")).toEqual({
		provider: "kimi-claude",
		promotionDeclined: true,
		lastSeenAt: 11,
	});
	expect(routing.getBlock("chat", "qwen-claude")).toEqual({
		category: "dynamic-throughput",
		lastSeenAt: 12,
		retryAt: undefined,
	});
	expect(routing.canOfferProvider("chat", "qwen-claude", 1_000)).toBe(false);
});
