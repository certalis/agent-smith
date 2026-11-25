import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

test("reads independent provider pools and router settings", () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-new-config-"));
	try {
		const path = join(directory, "config.json");
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					alpha: {
						enabled: true,
						strategy: "claude-code",
						pool: {
							members: ["seat-a"],
							max_usage: 0.8,
							weekly_max_usage_by_email: { "owner@example.test": 0.9 },
							caller_weekly_max_usage: { box: 0.7 },
							admission: { cap: 3, queue_limit: 4, wait_ms: 500 },
							block_when_all_full: false,
						},
					},
					beta: {
						enabled: true,
						strategy: "claude-code",
						pool: { members: ["seat-b"], max_usage: 0.7 },
					},
					key: { enabled: true, strategy: "anthropic-api" },
				},
				routing: {
					routes: { "anthropic-messages": ["alpha", "beta", "key"] },
					api_key_accounts: "chooser_or_fallback",
					callers: { box: { allow_fallbacks: true } },
					hold_seconds: 60,
				},
			}),
		);
		const settings = new Config(path);
		const reader = settings as unknown as {
			getRouting(): unknown;
			getTeamRouting(name: string): unknown;
			getBlockWhenAllFull(name: string): boolean;
		};
		expect(reader.getRouting()).toMatchObject({
			apiKeyAccounts: "chooser_or_fallback",
			callers: { box: { allowFallbacks: true } },
			holdSeconds: 60,
		});
		expect(reader.getTeamRouting("alpha")).toMatchObject({
			enabled: true,
			allowlistedAccountUuids: ["seat-a"],
			maxUsage: 0.8,
			weeklyMaxUsageByEmail: { "owner@example.test": 0.9 },
			callerWeeklyMaxUsage: { box: 0.7 },
			admissionCap: 3,
			admissionQueueLimit: 4,
			admissionWaitMs: 500,
		});
		expect(reader.getTeamRouting("beta")).toMatchObject({
			enabled: true,
			allowlistedAccountUuids: ["seat-b"],
			maxUsage: 0.7,
		});
		expect(reader.getTeamRouting("key")).toMatchObject({ enabled: false });
		expect(settings.getTeamRouting("alpha").blockWhenAllFull).toBe(false);
		expect(settings.getProviderPool("anthropic-messages")).toEqual([
			"alpha",
			"beta",
			"key",
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("enrollment preserves disabled sharing and saved members", () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-disabled-pool-"));
	try {
		const path = join(directory, "config.json");
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"claude-code": {
						enabled: true,
						pool: {
							enabled: false,
							members: ["old"],
							max_usage: 0.8,
							block_when_all_full: false,
						},
					},
				},
			}),
		);
		const settings = new Config(path);
		settings.allowAccountUuid("claude-code", "new");
		const reopened = new Config(path);
		expect(reopened.getTeamRouting("claude-code")).toMatchObject({
			enabled: false,
			allowlistedAccountUuids: ["old", "new"],
			maxUsage: 0.8,
		});
		expect(reopened.getTeamRouting("claude-code").blockWhenAllFull).toBe(false);
		reopened.removeAccountUuid("claude-code", "new");
		expect(new Config(path).getTeamRouting("claude-code")).toMatchObject({
			enabled: false,
			allowlistedAccountUuids: ["old"],
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("partial updates preserve pool and routing settings and reject invalid routes", () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-partial-config-"));
	try {
		const path = join(directory, "config.json");
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"claude-code": {
						enabled: true,
						pool: { members: ["seat"], max_usage: 0.8 },
					},
				},
				routing: {
					routes: { "anthropic-messages": ["claude-code"] },
					api_key_accounts: "chooser_or_fallback",
					hold_seconds: 30,
					callers: { box: { allow_fallbacks: true } },
				},
			}),
		);
		const config = new Config(path);
		config.setProviderPool("claude-code", { enabled: false });
		expect(config.getTeamRouting("claude-code")).toMatchObject({
			enabled: false,
			allowlistedAccountUuids: ["seat"],
			maxUsage: 0.8,
		});
		config.setProviderPool("claude-code", { enabled: true });
		expect(config.getTeamRouting("claude-code")).toMatchObject({
			enabled: true,
			allowlistedAccountUuids: ["seat"],
			maxUsage: 0.8,
		});
		config.setRouting({ callers: { other: { allow_fallbacks: true } } });
		expect(config.getRouting()).toMatchObject({
			routes: { "anthropic-messages": ["claude-code"] },
			apiKeyAccounts: "chooser_or_fallback",
			holdSeconds: 30,
			callers: { other: { allowFallbacks: true } },
		});
		for (const routes of [
			{ "anthropic-message": ["claude-code"] },
			{ "anthropic-messages": "claude-code" },
			{ "anthropic-messages": ["bad name"] },
		]) {
			expect(() => config.setRouting({ routes })).toThrow();
			expect(config.getProviderPool("anthropic-messages")).toEqual([
				"claude-code",
			]);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
