import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function configFrom(team_routing: unknown = {}) {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-weekly-cap-"));
	directories.push(directory);
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify({ team_routing }));
	return { config: new Config(path), path };
}

describe("weekly cap configuration", () => {
	it("defaults weekly usage to 95% while preserving the five-hour cap", () => {
		expect(configFrom().config.getTeamRouting()).toMatchObject({
			maxUsage: 0.9,
			weeklyMaxUsage: 0.95,
			weeklyMaxUsageByEmail: {},
		});
	});
	it("normalizes file and API email keys and persists caps across reload", () => {
		const { config, path } = configFrom({
			weekly_max_usage: 0.95,
			weekly_max_usage_by_email: { " Tech@Example.test ": 0.3 },
		});
		expect(config.getTeamRouting()).toMatchObject({
			weeklyMaxUsage: 0.95,
			weeklyMaxUsageByEmail: { "tech@example.test": 0.3 },
		});
		config.setTeamRouting({ enabled: false });
		expect(new Config(path).getTeamRouting()).toMatchObject({
			enabled: false,
			weeklyMaxUsageByEmail: { "tech@example.test": 0.3 },
		});
		config.setTeamRouting({
			max_usage: 0.8,
			weekly_max_usage: 0.9,
			weekly_max_usage_by_email: { " Other@Example.test ": 0.95 },
		});
		expect(new Config(path).getRuntime().teamRouting).toMatchObject({
			maxUsage: 0.8,
			weeklyMaxUsage: 0.9,
			weeklyMaxUsageByEmail: { "other@example.test": 0.95 },
		});
		expect(JSON.parse(readFileSync(path, "utf8")).team_routing).toEqual({
			max_usage: 0.8,
			weekly_max_usage: 0.9,
			weekly_max_usage_by_email: { "other@example.test": 0.95 },
		});
	});
	it.each([
		...[0, -0.1, 0.951, Number.NaN, Infinity, "0.3", null].map((value) => ({
			weekly_max_usage: value,
		})),
		...[0, -0.1, 0.951, Number.NaN, Infinity, "0.3", null].map((value) => ({
			weekly_max_usage_by_email: { "tech@example.test": value },
		})),
		{ weekly_max_usage_by_email: { "invalid-email": 0.3 } },
		{ weekly_max_usage_by_email: [] },
		{ weekly_max_usage_by_email: null },
	])("rejects invalid weekly policy without replacing the saved policy: %j", (bad) => {
		const { config, path } = configFrom({ enabled: true, max_usage: 0.8 });
		const before = config.getTeamRouting();
		const saved = readFileSync(path, "utf8");
		expect(() => config.setTeamRouting({ enabled: false, ...bad })).toThrow();
		expect(config.getTeamRouting()).toEqual(before);
		expect(readFileSync(path, "utf8")).toBe(saved);
	});
});
