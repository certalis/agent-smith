import { expect, test } from "bun:test";
import { normalizeClaudeCodeUsage } from "./usage";

test("normalizes zero-spend OAuth usage including scoped weekly limits", () => {
	const usage = normalizeClaudeCodeUsage(
		{
			five_hour: { used_percentage: 15, resets_at: 1_700_000_000 },
			seven_day: { utilization: 0.2 },
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
