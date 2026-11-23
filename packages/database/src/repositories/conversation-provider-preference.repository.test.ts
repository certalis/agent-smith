import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";
import { ConversationProviderPreferenceRepository } from "./conversation-provider-preference.repository";

let db: Database;
let preferences: ConversationProviderPreferenceRepository;

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	preferences = new ConversationProviderPreferenceRepository(db);
});

afterEach(() => {
	db.close();
});

test("upserts an opaque conversation provider choice and promotion refusal", () => {
	preferences.upsert("opaque-pin", "kimi-claude", false, 100);
	preferences.upsert("opaque-pin", "kimi-claude", true, 200);

	expect(preferences.find("opaque-pin")).toEqual({
		provider: "kimi-claude",
		promotionDeclined: true,
		lastSeenAt: 200,
	});
});

test("expires stale preferences and deletes a preference with its pinned account", () => {
	db.run(
		`INSERT INTO conversation_pins (pin_key, account_id, last_seen_at) VALUES (?, ?, ?)`,
		["account-pin", "account-a", 100],
	);
	db.run(
		`INSERT INTO conversation_pins (pin_key, account_id, last_seen_at) VALUES (?, ?, ?)`,
		["other-pin", "account-b", 200],
	);
	preferences.upsert("account-pin", "kimi-claude", true, 100);
	preferences.upsert("other-pin", "qwen-claude", false, 200);

	preferences.deleteForAccount("account-a");
	preferences.deleteExpired(150);

	expect(preferences.find("account-pin")).toBeNull();
	expect(preferences.find("other-pin")).toEqual({
		provider: "qwen-claude",
		promotionDeclined: false,
		lastSeenAt: 200,
	});
});
