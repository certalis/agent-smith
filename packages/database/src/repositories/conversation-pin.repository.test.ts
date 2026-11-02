import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";
import { ConversationPinRepository } from "./conversation-pin.repository";

let db: Database;
let pins: ConversationPinRepository;

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	pins = new ConversationPinRepository(db);
});

afterEach(() => {
	db.close();
});

test("upserts, reads, counts, and expires opaque conversation pins", () => {
	pins.upsert("pin-one", "account-a", 100);
	pins.upsert("pin-two", "account-a", 150);
	pins.upsert("pin-three", "account-b", 200);
	pins.upsert("pin-one", "account-b", 250);

	expect(pins.find("pin-one")).toEqual({
		accountId: "account-b",
		lastSeenAt: 250,
	});
	expect(pins.countByAccount(0)).toEqual(
		new Map([
			["account-a", 1],
			["account-b", 2],
		]),
	);

	pins.deleteExpired(200);
	expect(pins.find("pin-two")).toBeNull();
	expect(pins.find("pin-one")).toEqual({
		accountId: "account-b",
		lastSeenAt: 250,
	});
});
