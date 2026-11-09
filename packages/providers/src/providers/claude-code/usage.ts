import type { AccountQuotaState } from "@agent-smith/types";

export const CLAUDE_CODE_USAGE_URL =
	"https://api.anthropic.com/api/oauth/usage";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as RecordValue)
		: undefined;
}

function number(value: unknown): number | null {
	const parsed =
		typeof value === "string" || typeof value === "number"
			? Number(value)
			: Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function utilization(value: RecordValue): number | null {
	const raw = number(
		value.used_percentage ??
			value.usedPercentage ??
			value.percent ??
			value.utilization,
	);
	if (raw === null) return null;
	return raw > 1 ? raw / 100 : raw;
}

function resetAt(value: RecordValue): number | null {
	const raw = value.resets_at ?? value.reset_at ?? value.resetAt;
	if (typeof raw === "string" && !/^\d+(?:\.\d+)?$/.test(raw)) {
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : null;
	}
	const numeric = number(raw);
	return numeric === null
		? null
		: numeric < 10_000_000_000
			? numeric * 1_000
			: numeric;
}

function window(value: unknown, seenAt: number) {
	const source = record(value);
	if (!source) return undefined;
	const used = utilization(source);
	const reset = resetAt(source);
	if (used === null && reset === null) return undefined;
	return { utilization: used, resetAt: reset, seenAt, status: null };
}

/** Converts the zero-spend OAuth usage payload into our quota shape. */
export function normalizeClaudeCodeUsage(
	payload: unknown,
	now: number = Date.now(),
): AccountQuotaState | null {
	const source = record(payload);
	if (!source) return null;
	const windows: AccountQuotaState["windows"] = {};
	const named: Array<[string, unknown]> = [
		["unified5h", source.five_hour ?? source.fiveHour],
		["unified7d", source.seven_day ?? source.sevenDay],
		["unified7dSonnet", source.seven_day_sonnet ?? source.sevenDaySonnet],
		["unified7dFable", source.seven_day_fable ?? source.sevenDayFable],
	];
	for (const [name, value] of named) {
		const parsed = window(value, now);
		if (parsed) windows[name] = parsed;
	}
	for (const entry of Array.isArray(source.limits) ? source.limits : []) {
		const limit = record(entry);
		const model = record(record(limit?.scope)?.model)?.display_name;
		if (typeof model !== "string") continue;
		const lower = model.toLowerCase();
		const name = lower.includes("fable")
			? "unified7dFable"
			: lower.includes("sonnet")
				? "unified7dSonnet"
				: lower.includes("opus")
					? "unified7dOpus"
					: undefined;
		if (!name) continue;
		const parsed = window(limit, now);
		if (parsed) windows[name] = parsed;
	}
	return Object.keys(windows).length > 0 ? { windows } : null;
}

export async function fetchClaudeCodeUsage(
	accessToken: string,
): Promise<AccountQuotaState | null> {
	const response = await fetch(CLAUDE_CODE_USAGE_URL, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!response.ok) {
		throw new Error(
			`Claude Code usage request failed: HTTP ${response.status}`,
		);
	}
	return normalizeClaudeCodeUsage(await response.json());
}
