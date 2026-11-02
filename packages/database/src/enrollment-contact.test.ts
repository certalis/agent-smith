import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "./database-operations";

it("keeps optional enrollment contacts separate from accounts across reopen and removes them with their seat", () => {
	const directory = mkdtempSync(join(tmpdir(), "ccflare-enrollment-contacts-"));
	const path = join(directory, "pool.db");
	let database = new DatabaseOperations(path);
	try {
		const accountId = database.createOAuthAccount({
			name: "owner",
			provider: "claude-code",
			accessToken: "synthetic-access",
			refreshToken: "synthetic-refresh",
		}).id;
		database.setEnrollmentContact(accountId, {
			email: "remind@example.test",
			slackUserId: "U0123456789",
		});
		database.upsertConversationPin("owner-pin", accountId, 1);
		database.close();
		database = new DatabaseOperations(path);
		expect(database.getEnrollmentContact(accountId)).toEqual({
			email: "remind@example.test",
			slackUserId: "U0123456789",
		});
		expect(JSON.stringify(database.getAllAccounts())).not.toContain(
			"remind@example.test",
		);
		expect(database.deleteAccount(accountId)).toBe(true);
		expect(database.getEnrollmentContact(accountId)).toBeNull();
		expect(database.getConversationPin("owner-pin")).toBeNull();
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
