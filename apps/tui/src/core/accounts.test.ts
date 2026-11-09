import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@agent-smith/config";
import { DatabaseFactory } from "@agent-smith/database";
import { setAccountPoolMembership } from "./accounts";

const tempDirs: string[] = [];

function setup() {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-local-pool-"));
	tempDirs.push(directory);
	DatabaseFactory.reset();
	DatabaseFactory.initialize(join(directory, "agent-smith.db"));
	return {
		config: new Config(join(directory, "agent-smith.json")),
		db: DatabaseFactory.getInstance(),
	};
}

afterEach(() => {
	DatabaseFactory.reset();
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { force: true, recursive: true });
	}
});

describe("Local pool accounts", () => {
	it("adds and protects a verified OAuth seat through the validated team-routing policy", () => {
		const { config, db } = setup();
		const account = db.createOAuthAccount({
			name: "authorized-dev-seat",
			provider: "claude-code",
			accessToken: "synthetic-token",
			accountUuid: "authorized-seat-id",
		});

		setAccountPoolMembership(account.id, true, db, config);
		expect(config.getTeamRouting()).toMatchObject({
			enabled: true,
			allowlistedAccountUuids: ["authorized-seat-id"],
		});

		setAccountPoolMembership(account.id, false, db, config);
		expect(config.getTeamRouting()).toMatchObject({
			enabled: false,
			allowlistedAccountUuids: [],
		});
	});
});
