import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@ccflare/config";
import { DatabaseFactory } from "@ccflare/database";
import type { AccountDisplay } from "@ccflare/ui";
import { addAccount, formatAccountsTable } from "./account";

const tempDirs: string[] = [];

afterEach(() => {
	DatabaseFactory.reset();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function setup() {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-add-account-"));
	tempDirs.push(directory);
	DatabaseFactory.reset();
	DatabaseFactory.initialize(join(directory, "ccflare.db"));
	return {
		config: new Config(join(directory, "config.json")),
		db: DatabaseFactory.getInstance(),
	};
}

const account: AccountDisplay = {
	id: "acct_1",
	name: "work",
	provider: "openai",
	auth_method: "oauth",
	base_url: null,
	weight: 1,
	weightDisplay: "1x",
	created: new Date("2026-01-01T00:00:00.000Z"),
	lastUsed: null,
	requestCount: 2,
	totalRequests: 4,
	paused: false,
	tokenStatus: "valid",
	rateLimitStatus: "OK",
	sessionInfo: "-",
	rateLimit: {
		code: "ok",
		isLimited: false,
		until: null,
		resetAt: null,
		remaining: null,
	},
	session: {
		active: false,
		startedAt: null,
		requestCount: 0,
	},
};

describe("formatAccountsTable", () => {
	it("includes provider and auth_method columns", () => {
		const lines = formatAccountsTable([account]);

		expect(lines[1]).toContain("Provider");
		expect(lines[1]).toContain("Auth");
		expect(lines[1]).toContain("Weight");
		expect(lines[3]).toContain("openai");
		expect(lines[3]).toContain("oauth");
		expect(lines[3]).toContain("1x");
	});
});

describe("addAccount", () => {
	it("refuses a disabled subscription provider before prompting", async () => {
		const { config, db } = setup();

		await expect(
			addAccount(db, config, {
				name: "disabled-seat",
				provider: "claude-code",
			}),
		).rejects.toThrow("providers.claude-code.enabled");
	});

	it("adds an enabled API-key provider", async () => {
		const { config, db } = setup();

		await addAccount(db, config, {
			name: "anthropic-key",
			provider: "anthropic",
			adapter: {
				async input() {
					return "test-key";
				},
				async select() {
					throw new Error("not used");
				},
				async confirm() {
					return true;
				},
			},
		});

		expect(db.getAccountByName("anthropic-key")).toMatchObject({
			provider: "anthropic",
			auth_method: "api_key",
		});
	});
});
