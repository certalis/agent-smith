export const PROVIDER_WIRES = [
	"anthropic-messages",
	"openai-responses",
] as const;

export type ProviderWire = (typeof PROVIDER_WIRES)[number];

const PROVIDER_METADATA_MAP = {
	anthropic: {
		displayLabel: "Anthropic",
		authMethod: "api_key",
		supportsOAuth: false,
		supportsWebSocket: false,
		defaultBaseUrl: "https://api.anthropic.com",
		specialRequirements: [],
	},
	openai: {
		displayLabel: "OpenAI",
		authMethod: "api_key",
		supportsOAuth: false,
		supportsWebSocket: false,
		defaultBaseUrl: "https://api.openai.com/v1",
		specialRequirements: [],
	},
	"claude-code": {
		displayLabel: "Claude Code",
		authMethod: "oauth",
		supportsOAuth: true,
		supportsWebSocket: false,
		defaultBaseUrl: "https://api.anthropic.com",
		specialRequirements: ["Requires Claude Code OAuth authentication"],
	},
	codex: {
		displayLabel: "Codex",
		authMethod: "oauth",
		supportsOAuth: true,
		supportsWebSocket: true,
		defaultBaseUrl: "https://chatgpt.com/backend-api/codex",
		specialRequirements: ["Requires Codex OAuth authentication"],
	},
} as const satisfies Record<
	string,
	{
		displayLabel: string;
		authMethod: "api_key" | "oauth";
		supportsOAuth: boolean;
		supportsWebSocket: boolean;
		defaultBaseUrl: string;
		specialRequirements: readonly string[];
	}
>;

type ProviderMetadataMap = typeof PROVIDER_METADATA_MAP;

export type BuiltinAccountProvider = keyof ProviderMetadataMap;
export type AccountProvider = string;
export type AuthMethod = "api_key" | "oauth";
export type ProviderByAuthMethod<T extends AuthMethod> = {
	[K in BuiltinAccountProvider]: ProviderMetadataMap[K]["authMethod"] extends T
		? K
		: never;
}[BuiltinAccountProvider];
/**
 * Providers are config-defined at runtime. These aliases preserve the auth
 * method vocabulary for callers without closing the provider name set.
 */
export type ApiKeyProvider = AccountProvider;
export type OAuthProvider = AccountProvider;
export type ProviderMetadata<
	P extends BuiltinAccountProvider = BuiltinAccountProvider,
> = {
	canonicalName: P;
} & ProviderMetadataMap[P];

const providerNames = Object.freeze(
	Object.keys(PROVIDER_METADATA_MAP) as BuiltinAccountProvider[],
);
const authMethods = Object.freeze(
	Array.from(
		new Set(
			providerNames.map(
				(provider) => PROVIDER_METADATA_MAP[provider].authMethod,
			),
		),
	) as AuthMethod[],
);
const providerOptions = Object.freeze(
	providerNames.map((provider) => ({
		value: provider,
		label: PROVIDER_METADATA_MAP[provider].displayLabel,
	})),
);

/**
 * Cross-package provider metadata registry.
 * Single source of truth for provider capability facts that multiple packages
 * need (auth method, OAuth support, WebSocket support, display label, etc.).
 *
 * This is a simple Record, NOT a framework. Provider-specific runtime behavior
 * (request shaping, rate-limit parsing, etc.) stays in the provider classes.
 */
export const PROVIDER_META = PROVIDER_METADATA_MAP;

export const ACCOUNT_PROVIDERS = providerNames;
export const AUTH_METHODS = authMethods;
export const ACCOUNT_PROVIDER_OPTIONS = providerOptions;
export const API_KEY_PROVIDERS = Object.freeze(
	ACCOUNT_PROVIDERS.filter(
		(provider): provider is ProviderByAuthMethod<"api_key"> =>
			isApiKeyProvider(provider),
	),
);
export const OAUTH_PROVIDERS = Object.freeze(
	ACCOUNT_PROVIDERS.filter(
		(provider): provider is ProviderByAuthMethod<"oauth"> =>
			isOAuthProvider(provider),
	),
);

export function isAccountProvider(
	value: string,
): value is BuiltinAccountProvider {
	return Object.hasOwn(PROVIDER_METADATA_MAP, value);
}

export function isAuthMethod(value: string): value is AuthMethod {
	return AUTH_METHODS.includes(value as AuthMethod);
}

export function isProviderWire(value: string): value is ProviderWire {
	return PROVIDER_WIRES.includes(value as ProviderWire);
}

export function isApiKeyProvider(value: string): value is ApiKeyProvider {
	return (
		isAccountProvider(value) &&
		PROVIDER_METADATA_MAP[value].authMethod === "api_key"
	);
}

export function isOAuthProvider(value: string): value is OAuthProvider {
	return (
		isAccountProvider(value) &&
		PROVIDER_METADATA_MAP[value].authMethod === "oauth"
	);
}

export function getProviderMetadata<P extends BuiltinAccountProvider>(
	provider: P,
): ProviderMetadata<P> {
	return {
		canonicalName: provider,
		...PROVIDER_METADATA_MAP[provider],
	};
}

export function getProviderDisplayLabel(provider: string): string {
	return isAccountProvider(provider)
		? PROVIDER_METADATA_MAP[provider].displayLabel
		: provider;
}

export function getProviderAuthMethod(
	provider: BuiltinAccountProvider,
): AuthMethod {
	return PROVIDER_METADATA_MAP[provider].authMethod;
}

export function getProviderDefaultBaseUrl(
	provider: BuiltinAccountProvider,
): string {
	return PROVIDER_METADATA_MAP[provider].defaultBaseUrl;
}

export function getProviderSupportsWebSocket(
	provider: BuiltinAccountProvider,
): boolean {
	return PROVIDER_METADATA_MAP[provider].supportsWebSocket;
}

export function getProviderSpecialRequirements(
	provider: BuiltinAccountProvider,
): readonly string[] {
	return PROVIDER_METADATA_MAP[provider].specialRequirements;
}
