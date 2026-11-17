export const CALLER_LABEL_HEADER = "x-agent-smith-caller";
export const CALLER_LABEL_PREFIX = "label:";

/** Usage labels are metadata, never authentication or authorization. */
export function isCallerLabel(value: unknown): value is string {
	return typeof value === "string" && /^[-a-zA-Z0-9_]{1,64}$/.test(value);
}

/** Private report; label: IDs are self-reported, not authenticated owners. */
export interface CallerUsageRow {
	callerId: string | null;
	requests: number;
	pendingRequests: number;
	unreportedRequests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	totalTokens: number;
}

export interface CallerUsageQuery {
	startMs: number;
	endMs: number;
	model?: string;
	callerId?: string;
}

export interface CallerUsageResponse {
	startMs: number;
	endMs: number;
	rows: CallerUsageRow[];
	models: string[];
}
