import { describe, expect, it } from "bun:test";
import { renderMenubar } from "./menubar";
import type { PoolAccountStatus, PoolStatus } from "./pool-status";

const NOW = Date.UTC(2026, 0, 5, 12);
const HOUR = 3_600_000;

function reading(percent: number, { seenHoursAgo = 0, resetInHours = 2 } = {}) {
	return {
		utilization: percent / 100,
		seenAt: NOW - seenHoursAgo * HOUR,
		resetAt: NOW + resetInHours * HOUR,
		status: "allowed",
	};
}

function account(
	name: string,
	fiveHour: number,
	sevenDay: number,
	overrides: Partial<PoolAccountStatus> = {},
): PoolAccountStatus {
	return {
		name,
		paused: false,
		blocked: false,
		poolAllowed: true,
		tokenStatus: "valid",
		usage: {
			fiveHour: reading(fiveHour),
			sevenDay: reading(sevenDay, { resetInHours: 48 }),
			weeklyByModel: {},
		},
		...overrides,
	};
}

function pool(
	accounts: PoolAccountStatus[],
	overrides: Partial<PoolStatus> = {},
): PoolStatus {
	return {
		routingEnabled: true,
		maxUsagePercent: 90,
		enrollmentUrl: "https://pool.example.test/pool-enroll",
		emails: [],
		accounts,
		...overrides,
	};
}

const render = (status: PoolStatus, error: string | null = null) =>
	renderMenubar({ cached: { fetchedAt: NOW, status }, error }, NOW);

const rowOf = (lines: string[], name: string) =>
	lines.find((line) => line.includes(` ${name} `)) ?? "";

describe("renderMenubar", () => {
	it("counts serving accounts under the cap in both windows as free", () => {
		const lines = render(
			pool([
				account("alice", 10, 20),
				account("bob", 75, 10),
				account("carol", 95, 10),
				account("dave", 0, 0, { poolAllowed: false }),
			]),
		);

		expect(lines[0]).toBe(
			"2/3 | sfimage=person.3.fill sfcolor=#FF9500 emojize=false symbolize=false",
		);
		expect(rowOf(lines, "alice")).toStartWith("🟢");
		expect(rowOf(lines, "bob")).toStartWith("🟠");
		expect(rowOf(lines, "carol")).toStartWith("🔴");
		expect(lines.indexOf(rowOf(lines, "dave"))).toBeGreaterThan(
			lines.findIndex((line) => line.startsWith("Not serving")),
		);
		expect(rowOf(lines, "dave")).toStartWith("⚪");
	});

	it("treats a reading past its reset or older than its window as unknown", () => {
		const lines = render(
			pool([
				account("alice", 10, 20, {
					usage: {
						fiveHour: reading(10, { resetInHours: -1 }),
						sevenDay: reading(20, { seenHoursAgo: 200 }),
						weeklyByModel: {},
					},
				}),
			]),
		);

		expect(lines[0]).toStartWith("0/1 |");
		expect(rowOf(lines, "alice")).toContain("5h   ? ░░░░░░░░░░");
		expect(lines).toContain(
			"--alice: no current reading | emojize=false symbolize=false",
		);
	});

	it("keeps the last status with a warning when a refresh fails", () => {
		const lines = render(pool([account("alice", 10, 20)]), "timed out");

		expect(lines[0]).toStartWith("1/1 ⚠ |");
		expect(
			lines.some((line) => line.startsWith("Last refresh failed (timed out)")),
		).toBe(true);
	});

	it("explains why no status is available yet", () => {
		expect(
			renderMenubar({ cached: null, error: "Set client.pool_ssh_host" }, NOW),
		).toEqual([
			"| sfimage=person.3 sfcolor=#8E8E93",
			"---",
			"Pool status unavailable | color=#FF3B30",
			"Set client.pool_ssh_host | size=11 emojize=false symbolize=false",
			"---",
			"Refresh | refresh=true",
		]);
	});

	it("lists allowed emails without a connected account, skipping domain rules", () => {
		const lines = render(
			pool([account("alice", 10, 20)], {
				emails: ["alice@example.test", "erin@example.test", "*@example.test"],
			}),
		);

		expect(lines).toContain(
			"Allowed, not connected (1) | emojize=false symbolize=false color=#000000,#FFFFFF",
		);
		expect(lines).toContain(
			"--erin@example.test | emojize=false symbolize=false",
		);
	});

	it("keeps server text from adding SwiftBar parameters or links", () => {
		const lines = render(
			pool([account("evil | href=https://attacker.example.test\n", 10, 20)], {
				enrollmentUrl: "http://pool.example.test/pool-enroll",
			}),
		);

		expect(lines.some((line) => line.includes("| href="))).toBe(false);
		expect(
			lines.some((line) => line.startsWith("Open team sign-in page")),
		).toBe(false);
	});
});
