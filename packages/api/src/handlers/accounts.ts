import type { Config } from "@ccflare/config";
import {
	patterns,
	sanitizers,
	ValidationError,
	validateNumber,
	validateString,
} from "@ccflare/core";
import type { DatabaseOperations } from "@ccflare/database";
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@ccflare/http";
import { Logger } from "@ccflare/logger";
import { assertSeatAllowlisted } from "@ccflare/oauth-flow";
import type {
	OAuthAccountIdentity,
	ProviderRegistry,
} from "@ccflare/providers";
import {
	type AccountCreateData,
	type AccountDeleteData,
	type AccountPauseData,
	type AccountRenameData,
	type AccountSwitchThreshold,
	type AccountUpdateData,
	AUTH_METHODS,
	isAuthMethod,
	type MutationResult,
} from "@ccflare/types";
import { serializeAccount } from "../serializers/account";
import type { AccountResponse } from "../types";
import { parseJsonObject } from "../utils/json";

const log = new Logger("AccountsHandler");
const supportedAuthMethods = AUTH_METHODS;
const DEFAULT_ACCOUNT_WEIGHT = 1;
const createAccountFields = new Set([
	"name",
	"provider",
	"auth_method",
	"api_key",
	"apiKey",
	"access_token",
	"accessToken",
	"refresh_token",
	"refreshToken",
	"base_url",
	"baseUrl",
]);
const updateAccountFields = new Set([
	"name",
	"base_url",
	"baseUrl",
	"priority",
	"switchThreshold",
	"switch_threshold",
]);
function hasOwnField(body: Record<string, unknown>, field: string): boolean {
	return Object.hasOwn(body, field);
}

function normalizeBaseUrl(value: unknown): string | null {
	if (value === undefined) {
		return null;
	}

	if (value === null || value === "") {
		return null;
	}

	return (
		validateString(value, "base_url", {
			minLength: 1,
			transform: sanitizers.trim,
		}) || null
	);
}

function normalizeSwitchThreshold(
	value: unknown,
): AccountSwitchThreshold | null | undefined {
	if (value === null) return null;
	if (typeof value === "number") {
		return Number.isFinite(value) && value > 0 && value <= 1
			? value
			: undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	const entries = Object.entries(value);
	if (
		entries.length === 0 ||
		entries.some(
			([key, threshold]) =>
				key.length === 0 ||
				typeof threshold !== "number" ||
				!Number.isFinite(threshold) ||
				threshold <= 0 ||
				threshold > 1,
		)
	) {
		return undefined;
	}
	return Object.fromEntries(entries) as Record<string, number>;
}

function findUnexpectedField(
	body: Record<string, unknown>,
	allowedFields: ReadonlySet<string>,
): string | null {
	for (const key of Object.keys(body)) {
		if (!allowedFields.has(key)) {
			return key;
		}
	}

	return null;
}

function isDuplicateAccountNameError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("UNIQUE constraint failed: accounts.name") ||
			error.message.includes("already exists"))
	);
}

/**
 * Create an accounts list handler
 */
export function createAccountsListHandler(
	dbOps: DatabaseOperations,
	providerRegistry: ProviderRegistry,
) {
	return (): Response => {
		const now = Date.now();
		const response: AccountResponse[] = dbOps
			.getAllAccounts()
			.sort((left, right) => right.request_count - left.request_count)
			.map((account) => serializeAccount(account, providerRegistry, now));

		return jsonResponse(response);
	};
}

/**
 * Create an account add handler (manual token addition)
 * This is primarily used for adding accounts with existing tokens
 * For OAuth flow, use the OAuth handlers
 */
export function createAccountAddHandler(
	dbOps: DatabaseOperations,
	config: Config,
	providerRegistry: ProviderRegistry,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await parseJsonObject(req);

			const unexpectedField = findUnexpectedField(body, createAccountFields);
			if (unexpectedField) {
				return errorResponse(
					BadRequest(`Unknown field '${unexpectedField}' in account payload`),
				);
			}

			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				transform: sanitizers.trim,
			});
			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			// Validate provider
			const provider = validateString(body.provider, "provider", {
				required: true,
				minLength: 1,
				maxLength: 64,
				transform: sanitizers.trim,
			});
			if (!provider) {
				return errorResponse(BadRequest("Provider is required"));
			}
			const providerConfig = config.getProviderConfig(provider);
			const providerAuthMethod =
				providerRegistry.getProviderAuthMethod(provider);
			if (!providerConfig) {
				return errorResponse(BadRequest(`Unknown provider '${provider}'`));
			}
			if (!providerAuthMethod) {
				return errorResponse(
					BadRequest(
						`Provider '${provider}' is disabled. Set providers.${provider}.enabled to true in your config.`,
					),
				);
			}

			const authMethod = validateString(
				body.auth_method ??
					(body.api_key || body.apiKey
						? "api_key"
						: body.accessToken || body.access_token
							? "oauth"
							: undefined),
				"auth_method",
				{
					required: true,
					allowedValues: supportedAuthMethods,
					transform: sanitizers.trim,
				},
			);
			if (!authMethod || !isAuthMethod(authMethod)) {
				return errorResponse(BadRequest("auth_method is required"));
			}

			const allowedAuthMethod = providerAuthMethod;
			if (authMethod !== allowedAuthMethod) {
				return errorResponse(
					BadRequest(
						`Provider '${provider}' only supports auth_method '${allowedAuthMethod}'`,
					),
				);
			}

			const baseUrl = normalizeBaseUrl(body.base_url ?? body.baseUrl);

			try {
				let createdAccount: ReturnType<DatabaseOperations["createAccount"]>;
				if (authMethod === "api_key") {
					const apiKey =
						validateString(body.api_key ?? body.apiKey, "api_key", {
							minLength: 1,
						}) || null;

					if (!apiKey) {
						return errorResponse(
							BadRequest("API key is required for api_key accounts"),
						);
					}

					createdAccount = dbOps.createApiKeyAccount({
						name,
						provider,
						apiKey,
						baseUrl,
						weight: DEFAULT_ACCOUNT_WEIGHT,
					});
				} else {
					const accessToken =
						validateString(
							body.accessToken ?? body.access_token,
							"accessToken",
							{
								minLength: 1,
							},
						) || null;

					const refreshToken =
						validateString(
							body.refreshToken ?? body.refresh_token,
							"refreshToken",
							{
								minLength: 1,
							},
						) || null;

					if (!accessToken) {
						return errorResponse(
							BadRequest("Access token is required for oauth accounts"),
						);
					}
					const oauthProvider = providerRegistry.getOAuthProvider(provider);
					let identity: OAuthAccountIdentity | undefined;
					if (config.getTeamRouting().enabled) {
						try {
							identity = oauthProvider?.getAccountIdentity
								? await oauthProvider.getAccountIdentity({
										accessToken,
										refreshToken: refreshToken ?? "",
										expiresAt: 0,
									})
								: undefined;
							assertSeatAllowlisted(config, identity?.accountUuid);
						} catch (error) {
							if (
								error instanceof Error &&
								error.message.includes("configured allowlist")
							) {
								return errorResponse(BadRequest(error.message));
							}
							return errorResponse(
								BadRequest("Could not verify OAuth account identity"),
							);
						}
					}

					createdAccount = dbOps.createOAuthAccount({
						name,
						provider,
						accessToken,
						refreshToken,
						baseUrl,
						accountUuid: identity?.accountUuid,
						organizationUuid: identity?.organizationUuid,
						weight: DEFAULT_ACCOUNT_WEIGHT,
					});
				}

				const result: MutationResult<AccountCreateData> = {
					success: true,
					message: `Account '${name}' added successfully`,
					data: {
						accountId: createdAccount.id,
						weight: DEFAULT_ACCOUNT_WEIGHT,
						authMethod,
					},
				};
				return jsonResponse(result);
			} catch (error) {
				if (isDuplicateAccountNameError(error)) {
					return errorResponse(BadRequest(`Account '${name}' already exists`));
				}
				return errorResponse(InternalServerError((error as Error).message));
			}
		} catch (error) {
			if (error instanceof ValidationError) {
				return errorResponse(BadRequest(error.message));
			}
			log.error("Account add error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to add account"),
			);
		}
	};
}

/**
 * Create an account update handler
 */
export function createAccountUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await parseJsonObject(req);
			const account = dbOps.getAccount(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const unexpectedField = findUnexpectedField(body, updateAccountFields);
			if (unexpectedField) {
				return errorResponse(
					BadRequest(`Unknown field '${unexpectedField}' in account payload`),
				);
			}

			const hasName = hasOwnField(body, "name");
			const hasBaseUrl =
				hasOwnField(body, "base_url") || hasOwnField(body, "baseUrl");
			const hasPriority = hasOwnField(body, "priority");
			const hasSwitchThreshold =
				hasOwnField(body, "switchThreshold") ||
				hasOwnField(body, "switch_threshold");

			if (!hasName && !hasBaseUrl && !hasPriority && !hasSwitchThreshold) {
				return errorResponse(
					BadRequest(
						"At least one of 'name', 'base_url', 'priority', or 'switchThreshold' is required",
					),
				);
			}

			let nextName = account.name;
			if (hasName) {
				const validatedName = validateString(body.name, "name", {
					required: true,
					minLength: 1,
					maxLength: 100,
					pattern: patterns.accountName,
					transform: sanitizers.trim,
				});
				if (!validatedName) {
					return errorResponse(BadRequest("Account name is required"));
				}
				nextName = validatedName;
			}
			const nextBaseUrl = hasBaseUrl
				? normalizeBaseUrl(body.base_url ?? body.baseUrl)
				: account.base_url;
			const nextPriority = hasPriority
				? validateNumber(body.priority, "priority", {
						integer: true,
						min: 0,
						max: 1000,
					})
				: (account.priority ?? 0);
			if (nextPriority === undefined) {
				return errorResponse(BadRequest("priority must be an integer"));
			}
			const nextSwitchThreshold = hasSwitchThreshold
				? normalizeSwitchThreshold(
						body.switchThreshold ?? body.switch_threshold,
					)
				: (account.switch_threshold ?? null);
			if (nextSwitchThreshold === undefined) {
				return errorResponse(
					BadRequest(
						"switchThreshold must be a ratio from 0 (exclusive) to 1 (inclusive), or a non-empty table of ratios",
					),
				);
			}

			if (nextName !== account.name) {
				const existingAccount = dbOps.getAccountByName(nextName);

				if (existingAccount && existingAccount.id !== accountId) {
					return errorResponse(
						BadRequest(`Account name '${nextName}' is already taken`),
					);
				}
			}

			const updatedAccount = dbOps.updateAccount(accountId, {
				name: nextName,
				base_url: nextBaseUrl,
				priority: nextPriority,
				switch_threshold: nextSwitchThreshold,
			});

			if (!updatedAccount) {
				return errorResponse(NotFound("Account not found"));
			}

			const result: MutationResult<AccountUpdateData> = {
				success: true,
				message: `Account '${updatedAccount.name}' updated successfully`,
				data: {
					accountId,
					name: updatedAccount.name,
					baseUrl: updatedAccount.base_url,
					priority: updatedAccount.priority ?? 0,
					switchThreshold: updatedAccount.switch_threshold ?? null,
				},
			};
			return jsonResponse(result);
		} catch (error) {
			if (error instanceof ValidationError) {
				return errorResponse(BadRequest(error.message));
			}
			if (isDuplicateAccountNameError(error)) {
				return errorResponse(BadRequest("Account name is already taken"));
			}
			log.error("Account update error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to update account"),
			);
		}
	};
}

/**
 * Create an account remove handler
 */
export function createAccountRemoveHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = dbOps.getAccount(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (!dbOps.deleteAccount(account.id)) {
				return errorResponse(NotFound("Account not found"));
			}

			const result: MutationResult<AccountDeleteData> = {
				success: true,
				message: `Account '${account.name}' removed successfully`,
				data: { accountId: account.id },
			};
			return jsonResponse(result);
		} catch (error) {
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to remove account"),
			);
		}
	};
}

function createAccountPauseStateHandler(
	dbOps: DatabaseOperations,
	shouldPause: boolean,
) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = dbOps.getAccount(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const isPaused = account.paused;
			if (shouldPause && !isPaused) {
				dbOps.pauseAccount(accountId);
			}

			if (!shouldPause && isPaused) {
				dbOps.resumeAccount(accountId);
			}

			const actionPast = shouldPause ? "paused" : "resumed";
			const alreadyMessage = shouldPause ? "already paused" : "already resumed";

			const result: MutationResult<AccountPauseData> = {
				success: true,
				message:
					isPaused === shouldPause
						? `Account '${account.name}' is ${alreadyMessage}`
						: `Account '${account.name}' ${actionPast} successfully`,
				data: { paused: shouldPause },
			};
			return jsonResponse(result);
		} catch (error) {
			return errorResponse(
				error instanceof Error
					? error
					: new Error(
							shouldPause
								? "Failed to pause account"
								: "Failed to resume account",
						),
			);
		}
	};
}

/**
 * Create an account pause handler
 */
export function createAccountPauseHandler(dbOps: DatabaseOperations) {
	return createAccountPauseStateHandler(dbOps, true);
}

/**
 * Create an account resume handler
 */
export function createAccountResumeHandler(dbOps: DatabaseOperations) {
	return createAccountPauseStateHandler(dbOps, false);
}

/**
 * Create an account rename handler
 */
export function createAccountRenameHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await parseJsonObject(req);

			// Validate new name
			const newName = validateString(body.name, "name", {
				required: true,
				transform: sanitizers.trim,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
			});
			if (!newName) {
				return errorResponse(BadRequest("New account name is required"));
			}

			const account = dbOps.getAccount(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if new name is already taken
			const existingAccount = dbOps.getAccountByName(newName);

			if (existingAccount && existingAccount.id !== accountId) {
				return errorResponse(
					BadRequest(`Account name '${newName}' is already taken`),
				);
			}

			const renamedAccount = dbOps.updateAccount(accountId, { name: newName });

			if (!renamedAccount) {
				return errorResponse(NotFound("Account not found"));
			}

			const result: MutationResult<AccountRenameData> = {
				success: true,
				message: `Account renamed from '${account.name}' to '${renamedAccount.name}'`,
				data: { newName: renamedAccount.name },
			};
			return jsonResponse(result);
		} catch (error) {
			if (error instanceof ValidationError) {
				return errorResponse(BadRequest(error.message));
			}
			if (isDuplicateAccountNameError(error)) {
				return errorResponse(BadRequest("Account name is already taken"));
			}
			log.error("Account rename error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to rename account"),
			);
		}
	};
}
