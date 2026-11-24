import type { ProviderCapacityBlock } from "@agent-smith/capacity";

function retryAtFromHeader(
	response: Response,
	now: number,
): number | undefined {
	const retryAfter = response.headers.get("retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1_000;
	const date = Date.parse(retryAfter);
	return Number.isNaN(date) ? undefined : Math.max(now, date);
}

/**
 * Google uses HTTP 429 for RESOURCE_EXHAUSTED but does not promise a useful
 * reset in its error body. Preserve the fact of the block and only label it as
 * a short request-rate limit when the upstream explicitly supplied a deadline.
 */
export async function classifyGoogleGeminiCapacityBlock(
	response: Response,
	now: number = Date.now(),
): Promise<ProviderCapacityBlock | null> {
	if (response.status !== 429) return null;
	const retryAt = retryAtFromHeader(response, now);
	return retryAt === undefined
		? { category: "unknown" }
		: { category: "request-rate", retryAt };
}
