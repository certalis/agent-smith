import type { CapacitySource } from "@agent-smith/capacity";
import type {
	Account,
	AccountQuotaState,
	ProviderWire,
	ResetCreditRequest,
	ResetCreditResult,
	ResetCredits,
} from "@agent-smith/types";

export interface TokenRefreshResult {
	accessToken: string;
	expiresAt: number;
	refreshToken: string; // Always required - either new token or existing one
}

export interface RateLimitInfo {
	activeLimit?: string;
	isRateLimited: boolean;
	resetTime?: number;
	statusHeader?: string;
	remaining?: number;
	quotaState?: AccountQuotaState;
}

export type ProviderRequestTransformInput = {
	body: ArrayBuffer | null;
	headers: Headers;
	mappedModel: string | undefined;
	query: string;
	upstreamPath: string;
};

export type ProviderRequestTransform = {
	body: ArrayBuffer | null;
	query: string;
	upstreamPath: string;
};

export type ProviderResponseContext = {
	messageId: string;
	model: string | undefined;
};

/** A canonical request the selected provider cannot represent safely. */
export class ProviderRequestTransformError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderRequestTransformError";
	}
}

export interface Provider extends CapacitySource {
	name: string;
	defaultBaseUrl: string;
	wire: ProviderWire;
	/** Manual operator-only grants. Never invoked by inference or background probing. */
	supportsResetCredits?(account: Account): boolean;
	listResetCredits?(
		account: Account,
		accessToken: string,
	): Promise<ResetCredits>;
	consumeResetCredit?(
		account: Account,
		accessToken: string,
		attempt: ResetCreditRequest,
	): Promise<ResetCreditResult>;
	readResetQuota?(
		account: Account,
		accessToken: string,
	): Promise<AccountQuotaState | null>;

	/**
	 * Whether the provider supports websocket upgrades for the given upstream path.
	 */
	supportsWebSocket?(upstreamPath: string): boolean;

	/**
	 * Refresh the access token for an account
	 */
	refreshToken?(
		account: Account,
		clientId: string,
	): Promise<TokenRefreshResult>;

	/**
	 * Build the target URL for the provider
	 */
	buildUrl(upstreamPath: string, query: string, account?: Account): string;

	/**
	 * Prepare headers for the provider request
	 */
	prepareHeaders(headers: Headers, account: Account | null): Headers;

	/** Converts the canonical request only after routing has selected an account. */
	transformRequest?(
		input: ProviderRequestTransformInput,
	): ProviderRequestTransform;

	/**
	 * Parse rate limit information from response
	 */
	parseRateLimit(response: Response): RateLimitInfo;

	/**
	 * Returns the provider-owned quota buckets that can block a model.
	 * Undefined means every observed bucket is relevant.
	 */
	quotaBucketsFor(model: string | undefined): readonly string[] | undefined;

	/** Returns the provider's weekly bucket for conversation routing, if any. */
	weeklyBucketFor(model: string | undefined): string | undefined;

	/** Whether a quota bucket represents this provider's weekly allowance. */
	isWeeklyBucket(bucket: string): boolean;

	/** Whether a quota bucket represents this provider's five-hour session window. */
	isFiveHourBucket(bucket: string): boolean;

	/** Whether this account can be refreshed through the provider's quota probe. */
	supportsQuotaProbe(account: Account): boolean;

	/** Reads the provider's current subscription quota when probing is supported. */
	probeQuota(
		account: Account,
		accessToken: string,
	): Promise<AccountQuotaState | null>;

	/**
	 * Starts this seat's five-hour window with one minimal billed request on its
	 * own credentials, on `model` or the provider's cheapest. Resolves to the
	 * quota the reply carried; throws when the provider refuses it.
	 */
	startQuotaWindow?(
		account: Account,
		accessToken: string,
		model: string | null,
	): Promise<AccountQuotaState | null>;

	/**
	 * Process the response before returning to client
	 */
	processResponse?(
		response: Response,
		account: Account | null,
		context?: ProviderResponseContext,
	): Promise<Response>;

	/**
	 * Extract usage information from response if available
	 */
	extractUsageInfo?(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null>;

	/**
	 * Check if the response is a streaming response
	 */
	isStreamingResponse?(response: Response): boolean;

	/** Extracts the client conversation key carried by this protocol. */
	getClientSessionId?(headers: Headers): string | null;

	/** Returns the first user-visible turn used for conversation pinning. */
	getConversationOpening?(payload: unknown): unknown | null;

	/** Identifies provider-owned quota rejection responses without consuming them. */
	isQuotaRejection?(response: Response): Promise<boolean>;

	/** Identifies headers that make a 429 account-scoped rather than request-scoped. */
	hasRateLimitSignal?(headerName: string): boolean;

	/** Whether the upstream served this response past the plan's limit, billed to extra usage. */
	spendsExtraUsage?(response: Response): boolean;

	/** Optional local redirect listener required by an OAuth client. */
	getOAuthCallbackForwarder?(): {
		port: number;
		targetPath: string;
	};
}

// OAuth-specific types
export interface OAuthProviderConfig {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: string[];
	redirectUri: string;
}

export interface OAuthAccountIdentity {
	accountUuid: string;
	organizationUuid?: string;
}

export interface OAuthProvider {
	getOAuthConfig(): OAuthProviderConfig;
	exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
		signal?: AbortSignal,
	): Promise<TokenResult>;
	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string;
	getAccountIdentity?(tokens: TokenResult): Promise<OAuthAccountIdentity>;
}

export interface PKCEChallenge {
	verifier: string;
	challenge: string;
}

export interface TokenResult {
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
	accountId?: string;
}
