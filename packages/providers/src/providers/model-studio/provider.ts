import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import { classifyModelStudioCapacityBlock } from "../../connectors/model-studio-capacity";
import type { RateLimitInfo } from "../../types";
import { AnthropicProvider } from "../anthropic/provider";

function retryAt(response: Response): number | undefined {
	const value = response.headers.get("retry-after");
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Date.now() + Math.max(0, seconds) * 1000;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : Math.max(Date.now(), parsed);
}

/** Anthropic-wire Model Studio adapter with its own documented limit semantics. */
export class ModelStudioAnthropicProvider extends AnthropicProvider {
	async getCapacityBlock(
		response: Response,
	): Promise<ProviderCapacityBlock | null> {
		return await classifyModelStudioCapacityBlock(response);
	}

	parseRateLimit(response: Response): RateLimitInfo {
		if (response.status !== 429) return super.parseRateLimit(response);
		const resetTime = retryAt(response);
		return resetTime === undefined
			? { isRateLimited: true }
			: { isRateLimited: true, resetTime };
	}
}
