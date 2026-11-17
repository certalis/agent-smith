import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@agent-smith/config";
import { DatabaseOperations } from "@agent-smith/database";
import { startRetentionMaintenance } from "./retention-maintenance";

const directories: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function savePayloadRequest(dbOps: DatabaseOperations, id: string): void {
	dbOps.saveRequest(
		id,
		"POST",
		"/v1/openai/responses",
		"openai",
		"/responses",
		null,
		200,
		true,
		null,
		1,
		0,
		undefined,
		{ timestamp: Date.now() - 1_000, payload: { id } },
	);
}

function storedPayloadIds(dbOps: DatabaseOperations): string[] {
	return (
		dbOps
			.getDatabase()
			.query("SELECT id FROM request_payloads ORDER BY id")
			.all() as Array<{ id: string }>
	).map(({ id }) => id);
}

function setup(retentionDays: number) {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-retention-"));
	directories.push(directory);
	const configPath = join(directory, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({ data_retention_days: retentionDays }),
	);
	const dbOps = new DatabaseOperations(join(directory, "pool.db"));
	cleanups.push(() => dbOps.close());
	return { config: new Config(configPath), dbOps };
}

describe("startRetentionMaintenance", () => {
	it("deletes expired payloads at startup, then on every interval until stopped", async () => {
		const { config, dbOps } = setup(0);
		savePayloadRequest(dbOps, "before-start");

		const stop = startRetentionMaintenance(config, dbOps, 10);
		cleanups.unshift(stop);
		expect(storedPayloadIds(dbOps)).toEqual([]);

		savePayloadRequest(dbOps, "while-running");
		await Bun.sleep(40);
		expect(storedPayloadIds(dbOps)).toEqual([]);

		stop();
		savePayloadRequest(dbOps, "after-stop");
		await Bun.sleep(40);
		expect(storedPayloadIds(dbOps)).toEqual(["after-stop"]);
	});

	it("keeps payloads inside the retention window", async () => {
		const { config, dbOps } = setup(7);
		savePayloadRequest(dbOps, "recent");

		cleanups.unshift(startRetentionMaintenance(config, dbOps, 10));
		await Bun.sleep(40);
		expect(storedPayloadIds(dbOps)).toEqual(["recent"]);
	});
});
