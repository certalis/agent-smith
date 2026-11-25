import { expect, test } from "bun:test";
import * as config from "./index";

test("rewrites legacy routing into provider pools and caller routing", () => {
	const rewrite = config.rewriteLegacyConfig;
	expect(typeof rewrite).toBe("function");
	if (!rewrite) throw new Error("rewrite function missing");
	const old = {
		providers: {
			alpha: { enabled: true, strategy: "claude-code" },
			beta: { enabled: true, strategy: "claude-code" },
			key: { enabled: true, strategy: "anthropic-api" },
		},
		provider_pools: { "anthropic-messages": ["alpha", "beta", "key"] },
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["seat-a", "seat-b"],
			weekly_max_usage_by_email: { "owner@example.test": 0.9 },
			caller_weekly_max_usage: { box: 0.7 },
			caller_provider_fallback: { box: "ordered" },
			admission_cap: 3,
			admission_queue_limit: 4,
			admission_wait_ms: 500,
			hold_seconds: 60,
		},
		block_when_all_full: false,
		quota_threshold: 0.98,
	};
	const rewritten = rewrite(old);
	expect(rewritten).not.toHaveProperty("team_routing");
	expect(rewritten).not.toHaveProperty("provider_pools");
	expect(rewritten).not.toHaveProperty("block_when_all_full");
	expect(rewritten.routing).toMatchObject({
		routes: { "anthropic-messages": ["alpha", "beta", "key"] },
		api_key_accounts: "chooser_or_fallback",
		callers: { box: { allow_fallbacks: true } },
		hold_seconds: 60,
	});
	for (const name of ["alpha", "beta"])
		expect(
			(rewritten.providers as Record<string, { pool: unknown }>)[name]?.pool,
		).toMatchObject({
			members: ["seat-a", "seat-b"],
			weekly_max_usage_by_email: { "owner@example.test": 0.9 },
			caller_weekly_max_usage: { box: 0.7 },
			admission: { cap: 3, queue_limit: 4, wait_ms: 500 },
			block_when_all_full: false,
		});
	expect(rewritten.quota_threshold).toBe(0.98);
	expect(old.team_routing.enabled).toBe(true);
});

test("disabled legacy team routing never enables its dormant fallback rules", () => {
	const rewrite = config.rewriteLegacyConfig;
	expect(typeof rewrite).toBe("function");
	if (!rewrite) throw new Error("rewrite function missing");
	const rewritten = rewrite({
		team_routing: {
			enabled: false,
			caller_provider_fallback: { box: "ordered" },
			hold_seconds: 50,
		},
	});
	expect(rewritten.routing).toMatchObject({
		api_key_accounts: "everyone",
		callers: {},
		hold_seconds: 50,
	});
});

test("startup rejects legacy routing keys and points to the rewrite command", async () => {
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-legacy-config-"));
	try {
		const path = join(directory, "config.json");
		writeFileSync(path, JSON.stringify({ team_routing: { enabled: true } }));
		expect(() => new config.Config(path)).toThrow(
			/routing.*providers.*agent-smith config rewrite/i,
		);
		writeFileSync(
			path,
			JSON.stringify({
				provider_pools: { "anthropic-messages": ["claude-code"] },
			}),
		);
		expect(() => new config.Config(path)).toThrow(
			/routing.*providers.*agent-smith config rewrite/i,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("rewrites every example config without mutating its input", async () => {
	const { readdirSync, readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const directory = join(import.meta.dir, "../../../examples/config");
	const names = readdirSync(directory).filter((name) => name.endsWith(".json"));
	expect(names.length).toBeGreaterThan(0);
	for (const name of names) {
		const original: unknown = JSON.parse(
			readFileSync(join(directory, name), "utf8"),
		);
		const before = JSON.stringify(original);
		const converted = config.rewriteLegacyConfig(original);
		expect(JSON.stringify(original)).toBe(before);
		expect(converted).not.toHaveProperty("team_routing");
		expect(converted).not.toHaveProperty("provider_pools");
		expect(config.rewriteLegacyConfig(converted)).toEqual(converted);
	}
});

test("rewrite writes a separate private file and refuses to overwrite", async () => {
	const { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } =
		await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { rewriteConfigFile } = await import("./rewrite-file");
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-rewrite-"));
	try {
		const input = join(directory, "old.json"),
			output = join(directory, "new.json");
		const source =
			'{"team_routing":{"enabled":true,"allowlisted_account_uuids":["seat"]}}';
		writeFileSync(input, source);
		rewriteConfigFile(input, output);
		expect(readFileSync(input, "utf8")).toBe(source);
		expect(statSync(output).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(output, "utf8"))).toHaveProperty("routing");
		expect(() => rewriteConfigFile(input, output)).toThrow();
		expect(() => rewriteConfigFile(input, input)).toThrow(/different/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the checked-in examples equal the rewrite of each pre-switch example", async () => {
	const { readdirSync, readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const oldDir = join(import.meta.dir, "test-fixtures/legacy-examples");
	const currentDir = join(import.meta.dir, "../../../examples/config");
	const names = readdirSync(currentDir).filter((name) =>
		name.endsWith(".json"),
	);
	expect(readdirSync(oldDir).sort()).toEqual(names.sort());
	for (const name of names) {
		const previous: unknown = JSON.parse(
			readFileSync(join(oldDir, name), "utf8"),
		);
		const current: Record<string, unknown> = JSON.parse(
			readFileSync(join(currentDir, name), "utf8"),
		);
		expect(config.rewriteLegacyConfig(previous)).toEqual(current);
	}
});

test("preserves a dormant pool policy without enabling sharing", () => {
	const result = config.rewriteLegacyConfig({
		providers: { "claude-code": { enabled: true } },
		team_routing: {
			enabled: false,
			allowlisted_account_uuids: ["seat"],
			max_usage: 0.8,
		},
		block_when_all_full: false,
	});
	const provider = (result.providers as Record<string, { pool: unknown }>)[
		"claude-code"
	];
	expect(provider?.pool).toMatchObject({
		enabled: false,
		members: ["seat"],
		max_usage: 0.8,
		block_when_all_full: false,
	});
	expect(result.routing).toMatchObject({ api_key_accounts: "everyone" });
});
