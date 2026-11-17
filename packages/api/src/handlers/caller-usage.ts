import {
	buildAnalyticsQuery,
	type DatabaseOperations,
} from "@agent-smith/database";
import {
	CALLER_LABEL_PREFIX,
	type CallerUsageResponse,
	isCallerLabel,
	isTimeRange,
} from "@agent-smith/types";

/** Private report; the runtime requires an admin key even for this GET. */
export function createCallerUsageHandler(dbOps: DatabaseOperations) {
	return (params: URLSearchParams): Response => {
		const range = params.get("range") ?? "24h";
		const model = params.get("model") ?? undefined;
		const callerId = params.get("caller") ?? undefined;
		if (
			!isTimeRange(range) ||
			(model !== undefined && (!model.trim() || model.length > 200)) ||
			(callerId !== undefined &&
				!isCallerLabel(
					callerId.startsWith(CALLER_LABEL_PREFIX)
						? callerId.slice(CALLER_LABEL_PREFIX.length)
						: callerId,
				)) ||
			[...params.keys()].some(
				(key) =>
					!["range", "model", "caller"].includes(key) ||
					params.getAll(key).length !== 1,
			)
		) {
			return Response.json(
				{ error: "Invalid usage range, model or caller" },
				{ status: 400 },
			);
		}
		const endMs = Date.now();
		const {
			options: { startMs },
		} = buildAnalyticsQuery({ range, now: endMs });
		const result = dbOps.getCallerUsage({ startMs, endMs, model, callerId });
		return Response.json(
			{ startMs, endMs, ...result } satisfies CallerUsageResponse,
			{
				headers: { "cache-control": "no-store" },
			},
		);
	};
}
