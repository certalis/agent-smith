import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@ccflare/database";
import { seedFleet } from "./fleet";

test("seeds claude-code OAuth accounts with deterministic tokens and state", () => {
	const directory = mkdtempSync(join(tmpdir(), "ccflare-scenario-fleet-"));
	const dbPath = join(directory, "ccflare.db");
	const now = 1_700_000_000_000;

	try {
		const fleet = seedFleet({
			dbPath,
			defaultBaseUrl: "http://127.0.0.1:41000",
			now: () => now,
			accounts: [
				{ name: "a", rateLimitedFor: "6m" },
				{ name: "b", paused: true, baseUrl: "http://127.0.0.1:42000" },
			],
		});
		const db = new DatabaseOperations(dbPath);

		try {
			expect(fleet.tokenToAccount).toEqual(
				new Map([
					["tok-a", "a"],
					["tok-b", "b"],
				]),
			);
			expect(db.getAccountByName("a")).toMatchObject({
				provider: "claude-code",
				access_token: "tok-a",
				base_url: "http://127.0.0.1:41000",
				expires_at: now + 60 * 60 * 1000,
				rate_limited_until: now + 6 * 60 * 1000,
			});
			expect(db.getAccountByName("b")).toMatchObject({
				access_token: "tok-b",
				base_url: "http://127.0.0.1:42000",
				paused: true,
			});
		} finally {
			db.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
