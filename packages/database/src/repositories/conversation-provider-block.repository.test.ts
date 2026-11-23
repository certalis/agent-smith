import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";
import { ConversationProviderBlockRepository } from "./conversation-provider-block.repository";

let db: Database;
let blocks: ConversationProviderBlockRepository;

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	blocks = new ConversationProviderBlockRepository(db);
});

afterEach(() => {
	db.close();
});

test("keeps an unknown upstream block manual and releases a block after its known retry time", () => {
	blocks.upsert(
		"opaque-pin",
		"qwen-claude",
		"dynamic-throughput",
		undefined,
		100,
	);
	blocks.upsert("opaque-pin", "kimi-claude", "request-rate", 200, 100);

	expect(blocks.find("opaque-pin", "qwen-claude")).toEqual({
		category: "dynamic-throughput",
		retryAt: undefined,
		lastSeenAt: 100,
	});
	expect(blocks.find("opaque-pin", "kimi-claude")).toEqual({
		category: "request-rate",
		retryAt: 200,
		lastSeenAt: 100,
	});

	blocks.delete("opaque-pin", "qwen-claude");
	blocks.deleteExpired(150);
	expect(blocks.find("opaque-pin", "qwen-claude")).toBeNull();
	expect(blocks.find("opaque-pin", "kimi-claude")).toBeNull();
});
