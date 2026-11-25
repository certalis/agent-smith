import {
	fromGeminiGenerateContent,
	toGeminiGenerateContent,
	UnsupportedAnthropicFeatureError,
} from "@agent-smith/adapters";
import type { Account } from "@agent-smith/types";
import {
	BaseProvider,
	deleteClientCredentialHeaders,
	deleteTransportHeaders,
} from "../../base";
import { classifyRetryAfterCapacityBlock } from "../../connectors/retry-after-capacity";
import type {
	ProviderRequestTransform,
	ProviderRequestTransformInput,
	ProviderResponseContext,
} from "../../types";
import { ProviderRequestTransformError } from "../../types";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export class GoogleGeminiProvider extends BaseProvider {
	name = "google-gemini";
	defaultBaseUrl = DEFAULT_BASE_URL;
	wire = "anthropic-messages" as const;

	async getCapacityBlock(response: Response) {
		return await classifyRetryAfterCapacityBlock(response);
	}

	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const prepared = new Headers(headers);
		deleteClientCredentialHeaders(prepared);
		prepared.delete("anthropic-beta");
		prepared.delete("anthropic-version");
		prepared.delete("x-api-key");
		prepared.delete("x-goog-api-key");
		if (account?.api_key) prepared.set("x-goog-api-key", account.api_key);
		deleteTransportHeaders(prepared);
		return prepared;
	}

	transformRequest(
		input: ProviderRequestTransformInput,
	): ProviderRequestTransform {
		if (input.headers.has("anthropic-beta")) {
			throw new ProviderRequestTransformError(
				"Gemini adapter does not support Anthropic beta features",
			);
		}
		if (input.upstreamPath !== "/v1/messages") {
			throw new TypeError(
				"Gemini accepts only Anthropic /v1/messages requests",
			);
		}
		if (!input.body)
			throw new TypeError("Gemini requires a JSON Messages body");
		if (!input.mappedModel) {
			throw new TypeError("Gemini requires a configured model mapping");
		}
		try {
			const converted = toGeminiGenerateContent(
				JSON.parse(new TextDecoder().decode(input.body)) as unknown,
				input.mappedModel,
			);
			return {
				body: new TextEncoder().encode(JSON.stringify(converted.body)).buffer,
				query: converted.query,
				upstreamPath: converted.upstreamPath,
			};
		} catch (error) {
			if (
				error instanceof UnsupportedAnthropicFeatureError ||
				error instanceof SyntaxError ||
				error instanceof TypeError
			) {
				throw new ProviderRequestTransformError(error.message);
			}
			throw error;
		}
	}

	async processResponse(
		response: Response,
		_account: Account | null,
		context?: ProviderResponseContext,
	): Promise<Response> {
		if (!context?.model) return response;
		return await fromGeminiGenerateContent(response, {
			messageId: context.messageId,
			model: context.model,
		});
	}
}
