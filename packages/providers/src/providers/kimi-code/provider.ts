import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import { classifyRetryAfterCapacityBlock } from "../../connectors/retry-after-capacity";
import { AnthropicProvider } from "../anthropic/provider";

/**
 * Kimi Code's Anthropic endpoint answers a spent plan window with a bare 429,
 * which the generic adapter would return to the caller as a one-request limit;
 * a capacity block lets the pool offer or walk to the next provider instead.
 */
export class KimiCodeAnthropicProvider extends AnthropicProvider {
	async getCapacityBlock(
		response: Response,
	): Promise<ProviderCapacityBlock | null> {
		return await classifyRetryAfterCapacityBlock(response);
	}
}
