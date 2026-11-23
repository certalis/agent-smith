import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import {
	classifyModelStudioCapacityBlock,
	retryAtFromHeader,
} from "../../connectors/model-studio-capacity";
import type { RateLimitInfo } from "../../types";
import { AnthropicProvider } from "../anthropic/provider";

/** Anthropic-wire Model Studio adapter with its own documented limit semantics. */
export class ModelStudioAnthropicProvider extends AnthropicProvider {
	async getCapacityBlock(
		response: Response,
	): Promise<ProviderCapacityBlock | null> {
		return await classifyModelStudioCapacityBlock(response);
	}

	parseRateLimit(response: Response): RateLimitInfo {
		if (response.status !== 429) return super.parseRateLimit(response);
		const resetTime = retryAtFromHeader(response);
		return resetTime === undefined
			? { isRateLimited: true }
			: { isRateLimited: true, resetTime };
	}
}
