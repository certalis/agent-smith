import { TIME_CONSTANTS } from "@agent-smith/core";
import { isRecord } from "@agent-smith/types";

/** When idle pooled seats get their five-hour window started; off unless an operator turns it on. */
export interface WindowWarmupConfig {
	enabled: boolean;
	times: string[];
	timeZone: string;
	weekdaysOnly: boolean;
	model: string | null;
}

export type WindowWarmupFileConfig = {
	enabled?: boolean;
	times?: string[];
	time_zone?: string;
	weekdays_only?: boolean;
	model?: string;
};

export const WINDOW_WARMUP_DEFAULTS: WindowWarmupConfig = {
	enabled: false,
	times: ["06:00"],
	timeZone: "Europe/Paris",
	weekdaysOnly: true,
	model: null,
};

const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MAX_TIMES = 24;
const SATURDAY = 6;
const SUNDAY = 0;

function isLocalTimes(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= MAX_TIMES &&
		value.every((time) => typeof time === "string" && LOCAL_TIME.test(time))
	);
}

function isTimeZone(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 64) {
		return false;
	}
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/** One invalid or unknown field drops the whole schedule, so it stays off rather than half-applied. */
export function sanitizeWindowWarmup(
	value: unknown,
): WindowWarmupFileConfig | undefined {
	if (!isRecord(value)) return undefined;
	const result: WindowWarmupFileConfig = {};
	if (typeof value.enabled === "boolean") result.enabled = value.enabled;
	if (isLocalTimes(value.times)) result.times = [...new Set(value.times)];
	if (isTimeZone(value.time_zone)) result.time_zone = value.time_zone;
	if (typeof value.weekdays_only === "boolean") {
		result.weekdays_only = value.weekdays_only;
	}
	if (typeof value.model === "string" && MODEL_NAME.test(value.model)) {
		result.model = value.model;
	}
	return Object.keys(value).every((key) => key in result) ? result : undefined;
}

export function windowWarmupConfig(
	file: WindowWarmupFileConfig | undefined,
): WindowWarmupConfig {
	return {
		enabled: file?.enabled ?? WINDOW_WARMUP_DEFAULTS.enabled,
		times: [...(file?.times ?? WINDOW_WARMUP_DEFAULTS.times)],
		timeZone: file?.time_zone ?? WINDOW_WARMUP_DEFAULTS.timeZone,
		weekdaysOnly: file?.weekdays_only ?? WINDOW_WARMUP_DEFAULTS.weekdaysOnly,
		model: file?.model ?? WINDOW_WARMUP_DEFAULTS.model,
	};
}

export function windowWarmupFileConfig(
	config: WindowWarmupConfig,
): WindowWarmupFileConfig {
	return {
		enabled: config.enabled,
		times: [...config.times],
		time_zone: config.timeZone,
		weekdays_only: config.weekdaysOnly,
		...(config.model && { model: config.model }),
	};
}

const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

function wallClockFormat(timeZone: string): Intl.DateTimeFormat {
	let format = wallClockFormats.get(timeZone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		wallClockFormats.set(timeZone, format);
	}
	return format;
}

function wallClock(at: number, timeZone: string) {
	const parts = wallClockFormat(timeZone).formatToParts(at);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((entry) => entry.type === type)?.value);
	return {
		year: part("year"),
		month: part("month"),
		day: part("day"),
		hour: part("hour") % 24,
		minute: part("minute"),
		second: part("second"),
	};
}

function zoneOffsetMs(at: number, timeZone: string): number {
	const wall = wallClock(at, timeZone);
	return (
		Date.UTC(
			wall.year,
			wall.month - 1,
			wall.day,
			wall.hour,
			wall.minute,
			wall.second,
		) -
		Math.floor(at / 1_000) * 1_000
	);
}

/** The instant the zone's clock shows `wall` (a wall time written as UTC), with that day's own offset. */
function zonedInstant(wall: number, timeZone: string): number {
	return wall - zoneOffsetMs(wall - zoneOffsetMs(wall, timeZone), timeZone);
}

/** The first configured local time strictly after `after`, or null while warm-up is off. */
export function nextWindowWarmupAt(
	routing: { enabled: boolean; windowWarmup: WindowWarmupConfig },
	after: number,
): number | null {
	const warmup = routing.windowWarmup;
	if (!routing.enabled || !warmup.enabled) return null;
	const today = wallClock(after, warmup.timeZone);
	for (let offset = 0; offset < 8; offset++) {
		const day = Date.UTC(today.year, today.month - 1, today.day + offset);
		const weekday = new Date(day).getUTCDay();
		if (warmup.weekdaysOnly && (weekday === SATURDAY || weekday === SUNDAY)) {
			continue;
		}
		const instants = warmup.times
			.map((time) => {
				const [hour = 0, minute = 0] = time.split(":").map(Number);
				return zonedInstant(
					day + hour * TIME_CONSTANTS.HOUR + minute * TIME_CONSTANTS.MINUTE,
					warmup.timeZone,
				);
			})
			.filter((at) => at > after);
		if (instants.length > 0) return Math.min(...instants);
	}
	return null;
}
