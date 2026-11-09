import type { Config } from "@agent-smith/config";
import type { DatabaseOperations } from "@agent-smith/database";
import {
	type ClaudeCodeProfile,
	createConfiguredProviderRegistry,
	fetchClaudeCodeProfile,
	generatePKCE,
	type OAuthProvider,
	type OAuthProviderConfig,
	type OAuthTokens,
	type PKCEChallenge,
	type ProviderRegistry,
} from "@agent-smith/providers";
import { type AccountProvider, isRecord } from "@agent-smith/types";

export type { AccountProvider as OAuthFlowProvider } from "@agent-smith/types";

/**
 * Resolves the OAuthProvider implementation via the provider registry
 * rather than hardcoding class constructors.
 */
function getOAuthProviderForFlow(
	provider: AccountProvider,
	providerRegistry: ProviderRegistry,
): OAuthProvider {
	const oauthProvider = providerRegistry.getOAuthProvider(provider);
	if (!oauthProvider) {
		throw new Error(
			`Provider '${provider}' is disabled or does not support OAuth.`,
		);
	}
	return oauthProvider;
}

function getOAuthConfigForFlow(
	config: Config,
	oauthProvider: OAuthProvider,
): OAuthProviderConfig {
	const oauthConfig = oauthProvider.getOAuthConfig();

	if (!oauthConfig.clientId) {
		oauthConfig.clientId = config.getRuntime().clientId;
	}

	return oauthConfig;
}

export interface BeginOptions {
	name: string;
	provider: AccountProvider;
}

export interface OAuthAuthorization {
	authUrl: string;
	pkce: PKCEChallenge;
	oauthConfig: OAuthProviderConfig;
}

export interface BeginResult extends OAuthAuthorization {
	sessionId: string;
}

export interface CompleteOptions {
	sessionId: string;
	code: string;
	name?: string;
	/**
	 * Allows the local control panel to persist a freshly verified seat before
	 * it appends that identity to the explicit pool allowlist. Other callers
	 * retain the normal allowlist check.
	 */
	allowUnlistedSeat?: boolean;
}

export interface AccountCreated {
	id: string;
	name: string;
	provider: AccountProvider;
	authType: "oauth";
}

export interface VerifiedClaudeSeat {
	tokens: OAuthTokens;
	identity: ClaudeCodeProfile;
}

export function assertSeatAllowlisted(
	config: Config,
	accountUuid: string | undefined,
): void {
	const teamRouting = config.getTeamRouting();
	if (
		teamRouting.enabled &&
		(!accountUuid || !teamRouting.allowlistedAccountUuids.includes(accountUuid))
	) {
		throw new Error("OAuth account is not on the configured allowlist");
	}
}

interface SessionState {
	verifier: string;
	state: string;
	status: "pending" | "completed";
}

/**
 * Handles OAuth flows for OAuth-only providers and persists transient auth
 * session state in the generic auth_sessions table.
 */
export class OAuthFlow {
	constructor(
		private dbOps: DatabaseOperations,
		private config: Config,
		private providerRegistry: ProviderRegistry,
	) {}

	/** Invitation capabilities own this state; generic callbacks must not find it. */
	beginClaudeSeat(): Promise<OAuthAuthorization> {
		return this.prepareAuthorization("claude-code");
	}

	/** Invitation-only verification: never persist credentials or an auth session. */
	async verifyClaudeSeat(
		flow: OAuthAuthorization,
		code: string,
	): Promise<VerifiedClaudeSeat> {
		const state = code.split("#");
		if (state.length !== 2 || !state[0] || state[1] !== flow.pkce.verifier) {
			throw new Error("Invalid enrollment authorization");
		}
		const provider = getOAuthProviderForFlow(
			"claude-code",
			this.providerRegistry,
		);
		const signal = AbortSignal.timeout(15_000);
		const tokens = await provider.exchangeCode(
			code,
			flow.pkce.verifier,
			flow.oauthConfig,
			signal,
		);
		const identity = await fetchClaudeCodeProfile(tokens.accessToken, signal);
		if (
			!identity.accountUuid.trim() ||
			!identity.organizationUuid.trim() ||
			typeof tokens.accessToken !== "string" ||
			!tokens.accessToken ||
			typeof tokens.refreshToken !== "string" ||
			!tokens.refreshToken ||
			typeof tokens.expiresAt !== "number" ||
			!Number.isFinite(tokens.expiresAt) ||
			tokens.expiresAt <= Date.now()
		)
			throw new Error("Incomplete Claude enrollment response");
		return { tokens, identity };
	}

	/**
	 * Starts an OAuth flow for an OAuth-only provider.
	 *
	 * @param opts - OAuth flow options
	 * @param opts.name - Unique account name
	 * @returns OAuth flow data including auth URL and session info
	 * @throws {Error} If account name already exists
	 */
	async begin(opts: BeginOptions): Promise<BeginResult> {
		const { name, provider } = opts;

		// Check if account already exists
		if (this.dbOps.getAccountByName(name)) {
			throw new Error(`Account with name '${name}' already exists`);
		}

		const authorization = await this.prepareAuthorization(provider);

		const sessionState: SessionState = {
			verifier: authorization.pkce.verifier,
			state: authorization.pkce.verifier,
			status: "pending",
		};

		const sessionId = this.dbOps.createAuthSession(
			provider,
			"oauth",
			name,
			JSON.stringify(sessionState),
			Date.now() + 10 * 60 * 1000,
		);

		return {
			...authorization,
			sessionId,
		};
	}

	private async prepareAuthorization(
		provider: AccountProvider,
	): Promise<OAuthAuthorization> {
		const oauthProvider = getOAuthProviderForFlow(
			provider,
			this.providerRegistry,
		);
		const pkce = await generatePKCE();
		const oauthConfig = getOAuthConfigForFlow(this.config, oauthProvider);
		return {
			authUrl: oauthProvider.generateAuthUrl(oauthConfig, pkce),
			pkce,
			oauthConfig,
		};
	}

	/**
	 * Completes the OAuth flow after user authorization.
	 *
	 * @param opts - Completion options
	 * @param opts.sessionId - Session ID from {@link begin}
	 * @param opts.code - Authorization code from OAuth callback
	 * @param opts.name - Account name (must match the one from begin)
	 * @returns Created account information
	 * @throws {Error} If OAuth provider not found or token exchange fails
	 */
	async complete(
		opts: CompleteOptions,
		flowData?: BeginResult,
	): Promise<AccountCreated> {
		const { sessionId, code } = opts;
		const authSession = this.dbOps.getAuthSession(sessionId);
		if (!authSession) {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		if (authSession.authMethod !== "oauth") {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		const sessionState = this.parseSessionState(authSession.stateJson);
		const provider = authSession.provider;
		const name = opts.name ?? authSession.accountName;

		if (sessionState.status === "completed") {
			const existingAccount = this.dbOps.getAccountByName(name);

			if (
				existingAccount &&
				existingAccount.provider === provider &&
				existingAccount.auth_method === "oauth"
			) {
				return {
					id: existingAccount.id,
					name: existingAccount.name,
					provider,
					authType: "oauth",
				};
			}

			throw new Error("OAuth session has already been completed.");
		}

		const resolvedFlowData =
			flowData ??
			this.createFlowDataFromSession(sessionId, provider, sessionState);

		// Get OAuth provider
		const oauthProvider = getOAuthProviderForFlow(
			provider,
			this.providerRegistry,
		);

		// Exchange authorization code for tokens
		const tokens = await oauthProvider.exchangeCode(
			code,
			resolvedFlowData.pkce.verifier,
			resolvedFlowData.oauthConfig,
		);

		const identity = oauthProvider.getAccountIdentity
			? await oauthProvider.getAccountIdentity(tokens)
			: undefined;
		if (!opts.allowUnlistedSeat) {
			assertSeatAllowlisted(
				this.config,
				identity?.accountUuid ?? tokens.accountId,
			);
		}
		const account = this.createAccountWithOAuth(
			name,
			provider,
			tokens,
			identity,
		);
		this.dbOps.updateAuthSessionState(
			sessionId,
			JSON.stringify({
				...sessionState,
				status: "completed",
			} satisfies SessionState),
			Date.now() + 5 * 60 * 1000,
		);
		return account;
	}

	private createFlowDataFromSession(
		sessionId: string,
		provider: AccountProvider,
		sessionState: SessionState,
	): BeginResult {
		const oauthProvider = getOAuthProviderForFlow(
			provider,
			this.providerRegistry,
		);
		const oauthConfig = getOAuthConfigForFlow(this.config, oauthProvider);

		return {
			sessionId,
			authUrl: "",
			pkce: {
				verifier: sessionState.verifier,
				challenge: "",
			},
			oauthConfig,
		};
	}

	private parseSessionState(stateJson: string): SessionState {
		let parsed: unknown;
		try {
			parsed = JSON.parse(stateJson);
		} catch {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		if (!isRecord(parsed) || typeof parsed.verifier !== "string") {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		if (typeof parsed.state !== "string") {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		if (parsed.status !== "pending" && parsed.status !== "completed") {
			throw new Error("OAuth session expired or invalid. Please try again.");
		}

		return {
			verifier: parsed.verifier,
			state: parsed.state,
			status: parsed.status,
		};
	}

	private createAccountWithOAuth(
		name: string,
		provider: AccountProvider,
		tokens: OAuthTokens,
		identity?: { accountUuid: string; organizationUuid?: string },
	): AccountCreated {
		const account = this.dbOps.createOAuthAccount({
			name,
			provider,
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken ?? null,
			expiresAt: tokens.expiresAt,
			accountUuid: identity?.accountUuid ?? tokens.accountId,
			organizationUuid: identity?.organizationUuid,
		});

		return {
			id: account.id,
			name: account.name,
			provider,
			authType: "oauth",
		};
	}
}

// Helper function for simpler usage
export async function createOAuthFlow(
	dbOps: DatabaseOperations,
	config: Config,
	providerRegistry = createConfiguredProviderRegistry(
		config.getProviderConfigs(),
	),
): Promise<OAuthFlow> {
	return new OAuthFlow(dbOps, config, providerRegistry);
}
