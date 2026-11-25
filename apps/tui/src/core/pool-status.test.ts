import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type PoolStatusSources,
	readPoolStatus,
	summarizePool,
} from "./pool-status";

const FIVE_HOUR = {
	utilization: 0.4,
	seenAt: 1,
	resetAt: 2,
	status: "allowed",
};
const SEVEN_DAY = {
	utilization: 0.6,
	seenAt: 1,
	resetAt: 3,
	status: "allowed",
};

function fleetAccount(id: string) {
	return {
		id,
		name: id,
		paused: false,
		tokenStatus: "valid",
		blockedReason: null,
		quotaWindows: { unified5h: FIVE_HOUR },
		base_url: "https://upstream.example.test",
		requestCount: 12,
	};
}

function sources(
	overrides: Partial<PoolStatusSources> = {},
): PoolStatusSources {
	return {
		accounts: [
			fleetAccount("alice"),
			fleetAccount("bob"),
			fleetAccount("carol"),
		],
		routing: {
			enabled: true,
			allowlistedAccountUuids: ["uuid-alice", "uuid-bob"],
			maxUsage: 0.9,
		},
		emails: ["alice@example.test"],
		memberships: [
			{
				id: "alice",
				account_uuid: "uuid-alice",
				auth_method: "oauth",
				provider: "claude-code",
			},
			{
				id: "bob",
				account_uuid: "uuid-bob",
				auth_method: "api_key",
				provider: "claude-code",
			},
			{
				id: "carol",
				account_uuid: "uuid-carol",
				auth_method: "oauth",
				provider: "claude-code",
			},
		],
		origin: "https://pool.example.test",
		...overrides,
	};
}

describe("summarizePool", () => {
	it("returns only the fields the menu bar shows", () => {
		const [alice] = sources().accounts;
		const status = summarizePool(
			sources({
				accounts: [
					{
						...(alice as PoolStatusSources["accounts"][number]),
						quotaWindows: {
							unified5h: FIVE_HOUR,
							unified7d: SEVEN_DAY,
							unified7dOpus: SEVEN_DAY,
							unified7dOther: SEVEN_DAY,
						},
					},
				],
			}),
		);

		expect(status).toEqual({
			routingEnabled: true,
			maxUsagePercent: 90,
			enrollmentUrl: "https://pool.example.test/pool-enroll",
			emails: ["alice@example.test"],
			accounts: [
				{
					name: "alice",
					paused: false,
					blocked: false,
					poolAllowed: true,
					tokenStatus: "valid",
					usage: {
						fiveHour: FIVE_HOUR,
						sevenDay: SEVEN_DAY,
						weeklyByModel: { Opus: SEVEN_DAY },
					},
				},
			],
		});
	});

	it("counts only allowlisted OAuth seats as pool members", () => {
		const allowed = (overrides: Partial<PoolStatusSources> = {}) =>
			summarizePool(sources(overrides)).accounts.map((a) => a.poolAllowed);

		expect(allowed()).toEqual([true, false, false]);
		expect(
			allowed({
				routing: { ...sources().routing, enabled: false },
			}),
		).toEqual([false, false, false]);
	});
});

it("reads the Claude pool endpoint and excludes other providers", async () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-pool-status-"));
	const dbPath = join(directory, "pool.db");
	const database = new Database(dbPath);
	database.run(
		"CREATE TABLE accounts (id TEXT, account_uuid TEXT, auth_method TEXT, provider TEXT)",
	);
	database.run(
		"INSERT INTO accounts VALUES ('alice', 'uuid-alice', 'oauth', 'claude-code'), ('codex', 'uuid-alice', 'oauth', 'codex')",
	);
	database.close();
	const originalFetch = globalThis.fetch;
	const requested: string[] = [];
	globalThis.fetch = Object.assign(
		async (url: RequestInfo | URL) => {
			const path = new URL(String(url)).pathname;
			requested.push(path);
			if (path === "/api/status")
				return Response.json({
					accounts: [fleetAccount("alice"), fleetAccount("codex")],
				});
			if (path === "/api/config/providers/claude-code/pool")
				return Response.json(sources().routing);
			if (path === "/api/enrollment-emails")
				return Response.json({ emails: [] });
			return new Response(null, { status: 404 });
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
	try {
		const status = await readPoolStatus({
			origin: "https://pool.example.test",
			socketPath: "/tmp/unused.sock",
			dbPath,
			adminKey: "test",
		});
		expect(requested).toContain("/api/config/providers/claude-code/pool");
		expect(
			status.accounts.map((account) => [account.name, account.poolAllowed]),
		).toEqual([["alice", true]]);
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(directory, { recursive: true, force: true });
	}
});
