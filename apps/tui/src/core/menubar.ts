import type { QuotaWindow } from "@agent-smith/types";
import type { PoolAccountStatus, PoolStatus } from "./pool-status";

export type MenubarSnapshot = {
	cached: { fetchedAt: number; status: PoolStatus } | null;
	error: string | null;
};

const HOUR_MS = 3_600_000;
const STALE_READING_SECONDS = 15 * 60;
const NEAR_CAP_PERCENT = 70;
const GREEN = "#34C759";
const ORANGE = "#FF9500";
const RED = "#FF3B30";
const GRAY = "#8E8E93";
const DOT: Record<string, string> = {
	[GREEN]: "🟢",
	[ORANGE]: "🟠",
	[RED]: "🔴",
	[GRAY]: "⚪",
};
const MONO = "font=Menlo size=12 emojize=false symbolize=false";
const PLAIN = "emojize=false symbolize=false";
const ROW_TEXT = "#000000,#FFFFFF";

const hhmm = new Intl.DateTimeFormat("en-GB", {
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});
const dayHhmm = new Intl.DateTimeFormat("en-GB", {
	weekday: "short",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});
const fullDateParts = new Intl.DateTimeFormat("en-GB", {
	weekday: "short",
	day: "numeric",
	month: "short",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

function fullDate(ms: number): string {
	const part = Object.fromEntries(
		fullDateParts.formatToParts(ms).map(({ type, value }) => [type, value]),
	);
	return `${part.weekday} ${part.day} ${part.month}, ${part.hour}:${part.minute}`;
}

type Row = {
	account: PoolAccountStatus;
	fiveHour: number | null;
	sevenDay: number | null;
	active: boolean;
	free: boolean;
	color: string;
	label: string;
};

export const clean = (value: unknown): string =>
	String(value ?? "")
		.replace(/[\p{C}|]/gu, " ")
		.replace(/^-+/, "")
		.trim();

function percentOf(
	window: QuotaWindow | null | undefined,
	nowMs: number,
	windowHours: number,
): number | null {
	if (
		!window ||
		typeof window.utilization !== "number" ||
		!Number.isFinite(window.utilization) ||
		window.utilization < 0
	)
		return null;
	if (window.resetAt !== null && window.resetAt <= nowMs) return null;
	if (nowMs - window.seenAt > windowHours * HOUR_MS) return null;
	return window.utilization * 100;
}

function resetLabel(
	window: QuotaWindow | null | undefined,
	format: Intl.DateTimeFormat,
	nowMs: number,
): string {
	return window?.resetAt && window.resetAt > nowMs
		? format.format(window.resetAt)
		: "";
}

function bar(percent: number | null): string {
	if (percent === null) return "░".repeat(10);
	const filled = Math.round(Math.min(Math.max(percent, 0), 100) / 10);
	return "█".repeat(filled) + "░".repeat(10 - filled);
}

const pct = (percent: number | null): string =>
	percent === null ? "  ?" : `${Math.round(percent)}%`.padStart(4);

function ageText(seconds: number | null): string {
	if (seconds === null) return "unknown age";
	if (seconds < 120) return `${seconds} s old`;
	if (seconds < 7200) return `${Math.round(seconds / 60)} min old`;
	if (seconds < 172800) return `${Math.round(seconds / 3600)} h old`;
	return `${Math.round(seconds / 86400)} days old`;
}

function stateOf(
	account: PoolAccountStatus,
	known: boolean,
	peak: number,
	cap: number,
): { color: string; label: string } {
	if (!account.poolAllowed)
		return {
			color: GRAY,
			label: account.paused ? "not in pool, paused" : "not in pool",
		};
	if (account.paused) return { color: GRAY, label: "paused" };
	if (account.blocked) return { color: RED, label: "unavailable (blocked)" };
	if (!known) return { color: GRAY, label: "no current reading" };
	if (peak >= cap) return { color: RED, label: `at the ${cap}% cap` };
	if (peak >= NEAR_CAP_PERCENT)
		return { color: ORANGE, label: "free, close to the cap" };
	return { color: GREEN, label: "free" };
}

function describe(account: PoolAccountStatus, cap: number, nowMs: number): Row {
	const fiveHour = percentOf(account.usage.fiveHour, nowMs, 5);
	const sevenDay = percentOf(account.usage.sevenDay, nowMs, 168);
	const active = account.poolAllowed && !account.paused;
	const known = fiveHour !== null && sevenDay !== null;
	const peak = Math.max(fiveHour ?? 0, sevenDay ?? 0);
	const free = active && !account.blocked && known && peak < cap;
	return {
		account,
		fiveHour,
		sevenDay,
		active,
		free,
		...stateOf(account, known, peak, cap),
	};
}

function windowLine(
	label: string,
	window: QuotaWindow | null | undefined,
	percent: number | null,
	nowMs: number,
): string {
	const reset =
		window?.resetAt && window.resetAt > nowMs
			? ` · resets ${fullDate(window.resetAt)}`
			: "";
	const used = percent === null ? "unknown" : `${Math.round(percent)}%`;
	return `--${label}: ${used}${reset} | ${PLAIN}`;
}

function accountLines(row: Row, nameWidth: number, nowMs: number): string[] {
	const { account, fiveHour, sevenDay } = row;
	const { usage } = account;
	const name = clean(account.name).padEnd(nameWidth);
	const fiveReset = resetLabel(usage.fiveHour, hhmm, nowMs).padEnd(5);
	const sevenReset = resetLabel(usage.sevenDay, dayHhmm, nowMs);
	const line = `${name}  5h ${pct(fiveHour)} ${bar(fiveHour)} ${fiveReset}   7d ${pct(sevenDay)} ${bar(sevenDay)} ${sevenReset}`;
	const lines = [
		`${DOT[row.color]} ${line.trimEnd()} | ${MONO} color=${ROW_TEXT}`,
		`--${clean(account.name)}: ${row.label} | ${PLAIN}`,
		"-----",
		windowLine("5h", usage.fiveHour, fiveHour, nowMs),
		windowLine("7d", usage.sevenDay, sevenDay, nowMs),
	];
	for (const [model, window] of Object.entries(usage.weeklyByModel))
		lines.push(
			windowLine(
				`${clean(model)} 7d`,
				window,
				percentOf(window, nowMs, 168),
				nowMs,
			),
		);
	const age = usage.fiveHour
		? Math.max(0, Math.round((nowMs - usage.fiveHour.seenAt) / 1000))
		: null;
	const ageColor =
		age !== null && age > STALE_READING_SECONDS ? ` color=${ORANGE}` : "";
	lines.push(
		"-----",
		`--Reading ${ageText(age)} | ${PLAIN} size=11${ageColor}`,
		`--Login token: ${clean(account.tokenStatus) || "unknown"} | ${PLAIN} size=11`,
	);
	return lines;
}

export function renderMenubar(
	{ cached, error }: MenubarSnapshot,
	nowMs: number,
): string[] {
	if (!cached)
		return [
			`| sfimage=person.3 sfcolor=${GRAY}`,
			"---",
			`Pool status unavailable | color=${RED}`,
			`${clean(error)} | size=11 ${PLAIN}`,
			"---",
			"Refresh | refresh=true",
		];
	const { fetchedAt, status } = cached;
	const cap = Number.isFinite(status.maxUsagePercent)
		? status.maxUsagePercent
		: 100;
	const rows = status.accounts
		.map((account) => describe(account, cap, nowMs))
		.sort((a, b) => clean(a.account.name).localeCompare(clean(b.account.name)));
	const active = rows.filter((row) => row.active);
	const inactive = rows.filter((row) => !row.active);
	const freeCount = active.filter((row) => row.free).length;
	const titleColor = freeCount === 0 ? RED : freeCount <= 2 ? ORANGE : GREEN;
	const nameWidth = Math.max(
		0,
		...rows.map((row) => clean(row.account.name).length),
	);
	const lines = [
		`${freeCount}/${active.length}${error ? " ⚠" : ""} | sfimage=person.3.fill sfcolor=${titleColor} ${PLAIN}`,
		"---",
		`Agent Smith pool · ${freeCount} of ${active.length} accounts free (5h and 7d both under ${cap}%) | ${PLAIN}`,
		`Routing ${status.routingEnabled ? "on" : "off"} · updated ${hhmm.format(fetchedAt)} · refreshes every 5 min | size=11 color=${GRAY} ${PLAIN}`,
	];
	if (error)
		lines.push(
			`Last refresh failed (${clean(error)}), showing ${hhmm.format(fetchedAt)} data | size=11 color=${ORANGE} ${PLAIN}`,
		);
	lines.push("---");
	for (const row of active) lines.push(...accountLines(row, nameWidth, nowMs));
	if (inactive.length) {
		lines.push("---", `Not serving | size=11 color=${GRAY}`);
		for (const row of inactive)
			lines.push(...accountLines(row, nameWidth, nowMs));
	}
	const names = new Set(rows.map((row) => clean(row.account.name)));
	const notConnected = status.emails.filter(
		(email) =>
			!email.startsWith("*@") && !names.has(clean(email).split("@")[0] ?? ""),
	);
	lines.push(
		"---",
		`Allowed, not connected (${notConnected.length}) | ${PLAIN} color=${ROW_TEXT}`,
		...notConnected.map((email) => `--${clean(email)} | ${PLAIN}`),
	);
	if (/^https:\/\//.test(status.enrollmentUrl))
		lines.push(`Open team sign-in page | href=${clean(status.enrollmentUrl)}`);
	lines.push("Refresh | refresh=true");
	return lines;
}
