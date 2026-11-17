import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const directories: string[] = [];
const envBefore = process.env.AGENT_SMITH_DATA_RETENTION_DAYS;

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
	if (envBefore === undefined)
		delete process.env.AGENT_SMITH_DATA_RETENTION_DAYS;
	else process.env.AGENT_SMITH_DATA_RETENTION_DAYS = envBefore;
});

function configFrom(data: Record<string, unknown> = {}) {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-retention-"));
	directories.push(directory);
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(data));
	return { config: new Config(path), path };
}

describe("payload retention", () => {
	it("keeps payloads 7 days by default", () => {
		delete process.env.AGENT_SMITH_DATA_RETENTION_DAYS;
		const { config } = configFrom();
		expect(config.getDataRetentionDays()).toBe(7);
		expect(config.getRuntime().storeRequestPayloads).toBe(true);
	});

	it("accepts 0 from the file, the setter and the environment as storing none", () => {
		delete process.env.AGENT_SMITH_DATA_RETENTION_DAYS;
		expect(
			configFrom({ data_retention_days: 0 }).config.storesRequestPayloads(),
		).toBe(false);

		const { config, path } = configFrom();
		config.setDataRetentionDays(0);
		expect(new Config(path).getRuntime().storeRequestPayloads).toBe(false);

		process.env.AGENT_SMITH_DATA_RETENTION_DAYS = "0";
		expect(
			configFrom({ data_retention_days: 7 }).config.getDataRetentionDays(),
		).toBe(0);
	});

	it("clamps out-of-range values to 0 and 365", () => {
		delete process.env.AGENT_SMITH_DATA_RETENTION_DAYS;
		expect(
			configFrom({ data_retention_days: -3 }).config.getDataRetentionDays(),
		).toBe(0);
		const { config } = configFrom();
		config.setDataRetentionDays(400);
		expect(config.getDataRetentionDays()).toBe(365);
	});
});
