import { AnthropicProvider } from "./providers/anthropic/provider";
import { ClaudeCodeProvider } from "./providers/claude-code/provider";
import { CodexProvider } from "./providers/codex/provider";
import { GoogleGeminiProvider } from "./providers/google-gemini/provider";
import { KimiCodeAnthropicProvider } from "./providers/kimi-code/provider";
import { ModelStudioAnthropicProvider } from "./providers/model-studio/provider";
import { OpenAIProvider } from "./providers/openai/provider";
import { ProviderRegistry } from "./registry";
import type { Provider } from "./types";

export type ProviderDefinition = {
	name: string;
	enabled: boolean;
	strategy: string;
	baseUrl?: string;
	models?: Record<string, string>;
};

export type ProviderPools = Partial<
	Record<import("@agent-smith/types").ProviderWire, readonly string[]>
>;

function createProvider(definition: ProviderDefinition): Provider {
	const provider = (() => {
		switch (definition.strategy) {
			case "anthropic-api":
				return new AnthropicProvider();
			case "model-studio-anthropic-api":
				return new ModelStudioAnthropicProvider();
			case "kimi-code-anthropic-api":
				return new KimiCodeAnthropicProvider();
			case "google-gemini-api":
				return new GoogleGeminiProvider();
			case "openai-api":
				return new OpenAIProvider();
			case "claude-code":
				return new ClaudeCodeProvider();
			case "codex":
				return new CodexProvider();
			default:
				throw new Error(
					`Unknown provider strategy '${definition.strategy}' for '${definition.name}'`,
				);
		}
	})();

	provider.name = definition.name;
	if (definition.baseUrl) {
		provider.defaultBaseUrl = definition.baseUrl;
	}
	return provider;
}

export function createConfiguredProviderRegistry(
	definitions: readonly ProviderDefinition[],
	providerPools: ProviderPools = {},
): ProviderRegistry {
	const enabled = definitions.filter((definition) => definition.enabled);
	return new ProviderRegistry(
		enabled.map((definition) => createProvider(definition)),
		{
			modelMaps: Object.fromEntries(
				enabled
					.filter((definition) => definition.models)
					.map((definition) => [definition.name, definition.models]),
			),
			providerPools,
		},
	);
}
