import { at, type RelativeTime } from "./scenario";

/** Headers of a 200 the upstream served past the 5h limit and billed to extra usage. */
export const servedOnExtraUsageHeaders: Record<string, string | RelativeTime> =
	{
		"anthropic-ratelimit-unified-status": "rejected",
		"anthropic-ratelimit-unified-reset": at("2h"),
		"anthropic-ratelimit-unified-5h-status": "rejected",
		"anthropic-ratelimit-unified-5h-utilization": "1.02",
		"anthropic-ratelimit-unified-5h-reset": at("2h"),
		"anthropic-ratelimit-unified-overage-status": "allowed",
	};
