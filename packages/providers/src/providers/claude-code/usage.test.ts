import { expect, test } from "bun:test";
import { normalizeClaudeCodeUsage } from "./usage";

test("normalizes zero-spend OAuth usage including scoped weekly limits", () => {
	const usage = normalizeClaudeCodeUsage(
		{
			five_hour: { used_percentage: 15, resets_at: 1_700_000_000 },
			seven_day: { utilization: 20 },
			limits: [
				{
					percent: 40,
					resets_at: "2026-01-01T00:00:00Z",
					scope: { model: { display_name: "Fable" } },
				},
			],
		},
		123,
	);
	expect(usage).toMatchObject({
		windows: {
			unified5h: {
				utilization: 0.15,
				resetAt: 1_700_000_000_000,
				seenAt: 123,
			},
			unified7d: { utilization: 0.2, seenAt: 123 },
			unified7dFable: {
				utilization: 0.4,
				resetAt: Date.parse("2026-01-01T00:00:00Z"),
			},
		},
	});
});

test.each([
	[0, 0],
	[0.5, 0.005],
	[1, 0.01],
	[90, 0.9],
	[100, 1],
])("normalizes OAuth usage %s percent to %s", (raw, expected) => {
	const usage = normalizeClaudeCodeUsage(
		{
			five_hour: { utilization: raw },
			seven_day: { used_percentage: raw },
			seven_day_sonnet: { usedPercentage: raw },
			limits: [
				{ percent: String(raw), scope: { model: { display_name: "Fable" } } },
			],
		},
		123,
	);
	for (const name of [
		"unified5h",
		"unified7d",
		"unified7dSonnet",
		"unified7dFable",
	]) {
		expect(usage?.windows[name]?.utilization).toBe(expected);
	}
});
