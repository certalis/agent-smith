/** Private administrator report; caller identity is never a provider account. */
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
