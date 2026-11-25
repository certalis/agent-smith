import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";
import {
	nextWindowWarmupAt,
	WINDOW_WARMUP_DEFAULTS,
	type WindowWarmupConfig,
} from "./window-warmup";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function configFrom(data: unknown): Config {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-warmup-"));
	tempDirs.push(directory);
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(data));
	return new Config(path);
}

function on(overrides: Partial<WindowWarmupConfig> = {}) {
	return {
		enabled: true,
		windowWarmup: { ...WINDOW_WARMUP_DEFAULTS, enabled: true, ...overrides },
	};
}

describe("window warm-up configuration", () => {
	it("is off until an operator turns it on, even with team routing on", () => {
		const config = configFrom({ providers: { "claude-code": { pool: {} } } });

		expect(config.getTeamRouting().windowWarmup).toEqual({
			enabled: false,
			times: ["06:00"],
			timeZone: "Europe/Paris",
			weekdaysOnly: true,
			model: null,
		});
		expect(nextWindowWarmupAt(config.getTeamRouting(), Date.now())).toBeNull();
	});

	it("refuses a schedule with an unknown time zone or field instead of half-applying it", () => {
		const config = configFrom({});

		for (const windowWarmup of [
			{ enabled: true, time_zone: "Europe/Nowhere" },
			{ enabled: true, times: ["6:00"] },
			{ enabled: true, every_day: true },
		]) {
			expect(() =>
				config.setProviderPool("claude-code", {
					enabled: true,
					window_warmup: windowWarmup,
				}),
			).toThrow("Invalid provider pool field: window_warmup");
		}
		expect(config.getTeamRouting().windowWarmup.enabled).toBe(false);
	});

	it("survives a restart once switched on", () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-smith-warmup-"));
		tempDirs.push(directory);
		const path = join(directory, "config.json");
		writeFileSync(
			path,
			JSON.stringify({ providers: { "claude-code": { pool: {} } } }),
		);

		new Config(path).setProviderPool("claude-code", {
			enabled: true,
			window_warmup: { enabled: true },
		});

		expect(new Config(path).getTeamRouting().windowWarmup.enabled).toBe(true);
	});

	it("refuses the change and keeps the running policy when the file cannot be written", () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-smith-warmup-"));
		tempDirs.push(directory);
		const path = join(directory, "config.json");
		writeFileSync(
			path,
			JSON.stringify({ providers: { "claude-code": { pool: {} } } }),
		);
		const config = new Config(path);
		chmodSync(directory, 0o500);

		try {
			expect(() =>
				config.setProviderPool("claude-code", {
					enabled: true,
					window_warmup: { enabled: true },
				}),
			).toThrow();
			expect(config.getTeamRouting().windowWarmup.enabled).toBe(false);
		} finally {
			chmodSync(directory, 0o700);
		}
	});
});

describe("next window warm-up", () => {
	it.each([
		[
			"Thursday before spring DST",
			"2026-03-26T10:00:00Z",
			"2026-03-27T05:00:00Z",
		],
		[
			"Friday, over the spring DST weekend",
			"2026-03-27T10:00:00Z",
			"2026-03-30T04:00:00Z",
		],
		[
			"Thursday before autumn DST",
			"2026-10-22T10:00:00Z",
			"2026-10-23T04:00:00Z",
		],
		[
			"Friday, over the autumn DST weekend",
			"2026-10-23T10:00:00Z",
			"2026-10-26T05:00:00Z",
		],
	])("fires at 06:00 Paris on the next weekday: %s", (_, after, expected) => {
		expect(nextWindowWarmupAt(on(), Date.parse(after))).toBe(
			Date.parse(expected),
		);
	});

	it("fires on a weekend day when weekdays_only is off, and at the soonest of several times", () => {
		expect(
			nextWindowWarmupAt(
				on({ weekdaysOnly: false, times: ["13:00", "06:00"] }),
				Date.parse("2026-03-28T04:00:00Z"),
			),
		).toBe(Date.parse("2026-03-28T05:00:00Z"));
	});

	it("never fires while team routing is off", () => {
		expect(
			nextWindowWarmupAt(
				{ ...on(), enabled: false },
				Date.parse("2026-03-26T10:00:00Z"),
			),
		).toBeNull();
	});
});
