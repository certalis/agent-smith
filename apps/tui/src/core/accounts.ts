import { Config } from "@ccflare/config";
import { DatabaseFactory } from "@ccflare/database";
import { type BeginResult, createOAuthFlow } from "@ccflare/oauth-flow";
import { createConfiguredProviderRegistry } from "@ccflare/providers";
import {
	type AccountProvider,
	type AddAccountOptions,
	type AuthMethod,
	getProviderDisplayLabel,
} from "@ccflare/types";
import { type AccountDisplay, toAccountDisplay } from "@ccflare/ui";
import * as cliCommands from "./cli";
import { openBrowser } from "./cli";
import {
	formatPoolLimits,
	type LocalPoolState,
	localPoolState,
	nextTeamRoutingConfig,
	teamRoutingFileConfig,
} from "./local-pool";

export interface AddAccountProviderOption {
	label: string;
	value: AddAccountOptions["provider"];
	authMethod: AuthMethod;
}

export type PreparedAddAccount =
	| {
			authMethod: "api_key";
			provider: AccountProvider;
	  }
	| {
			authMethod: "oauth";
			provider: AccountProvider;
			flowData: BeginResult;
	  };

export interface LocalPoolAccount extends AccountDisplay {
	poolState: LocalPoolState;
	poolLimits: string;
	providerDisabled: boolean;
}

export function getAddAccountProviderOptions(): AddAccountProviderOption[] {
	const config = new Config();
	const providerRegistry = createConfiguredProviderRegistry(
		config.getProviderConfigs(),
	);
	return providerRegistry.listProviders().map((provider) => ({
		label: getProviderDisplayLabel(provider),
		value: provider,
		authMethod: providerRegistry.getProviderAuthMethod(provider) as AuthMethod,
	}));
}

function getEnabledProvider(config: Config, provider: AccountProvider) {
	const providerConfig = config.getProviderConfig(provider);
	if (!providerConfig) {
		throw new Error(`Unknown provider '${provider}'.`);
	}
	const providerRegistry = createConfiguredProviderRegistry(
		config.getProviderConfigs(),
	);
	const authMethod = providerRegistry.getProviderAuthMethod(provider);
	if (!authMethod) {
		throw new Error(
			`Provider '${provider}' is disabled. Set providers.${provider}.enabled to true in your config.`,
		);
	}
	return { authMethod, providerRegistry };
}

async function openAuthUrl(authUrl: string): Promise<void> {
	console.log("\nOpening browser to authenticate...");
	const browserOpened = await openBrowser(authUrl);
	if (!browserOpened) {
		console.log(`Please open the following URL in your browser:\n${authUrl}`);
	}
}

/**
 * Prepare account creation by resolving the provider auth method once.
 * OAuth providers start the browser flow here; API key providers return
 * immediately so the caller can collect the key in the UI.
 */
export async function prepareAddAccount(
	options: AddAccountOptions,
): Promise<PreparedAddAccount> {
	const { name, provider } = options;
	const config = new Config();
	const { authMethod, providerRegistry } = getEnabledProvider(config, provider);

	if (authMethod === "api_key") {
		return {
			authMethod: "api_key",
			provider,
		};
	}

	const dbOps = DatabaseFactory.getInstance();
	const oauthFlow = await createOAuthFlow(dbOps, config, providerRegistry);
	const flowData = await oauthFlow.begin({
		name,
		provider,
	});

	await openAuthUrl(flowData.authUrl);

	return {
		authMethod: "oauth",
		provider,
		flowData,
	};
}

export async function submitAddAccount(
	options: AddAccountOptions & {
		apiKey?: string;
		code?: string;
		flowData?: BeginResult;
		addToPool?: boolean;
	},
): Promise<void> {
	const { name, provider, apiKey, code, flowData, addToPool = false } = options;
	const dbOps = DatabaseFactory.getInstance();
	const config = new Config();
	const { authMethod, providerRegistry } = getEnabledProvider(config, provider);

	if (authMethod === "api_key") {
		if (!apiKey) {
			throw new Error("API key is required for API key providers.");
		}

		dbOps.createApiKeyAccount({
			name,
			provider,
			apiKey,
		});
		return;
	}

	if (!flowData || !code) {
		throw new Error("Authorization code is required for OAuth providers.");
	}

	const oauthFlow = await createOAuthFlow(dbOps, config, providerRegistry);

	console.log("\nExchanging code for tokens...");
	const created = await oauthFlow.complete(
		{
			sessionId: flowData.sessionId,
			code,
			name,
			allowUnlistedSeat: addToPool,
		},
		flowData,
	);
	if (addToPool) {
		setAccountPoolMembership(created.id, true, dbOps, config);
	}

	console.log(`\nAccount '${name}' added successfully!`);
	console.log(`Provider: ${getProviderDisplayLabel(provider)}`);
	console.log(`Auth Method: ${authMethod}`);
}

export async function addAccount(options: AddAccountOptions): Promise<void> {
	const dbOps = DatabaseFactory.getInstance();
	const config = new Config();
	await cliCommands.addAccount(dbOps, config, {
		name: options.name,
		provider: options.provider,
	});
}

export async function getAccounts(): Promise<LocalPoolAccount[]> {
	const dbOps = DatabaseFactory.getInstance();
	const config = new Config();
	const routing = config.getTeamRouting();
	const providerRegistry = createConfiguredProviderRegistry(
		config.getProviderConfigs(),
	);
	const now = Date.now();
	return dbOps.getAllAccounts().map((account) => ({
		...toAccountDisplay(account, now),
		poolState: localPoolState(account, routing),
		poolLimits: formatPoolLimits(account.quota_state ?? null),
		providerDisabled: !providerRegistry.getProvider(account.provider),
	}));
}

export function setAccountPoolMembership(
	accountId: string,
	pooled: boolean,
	dbOps = DatabaseFactory.getInstance(),
	config = new Config(),
): void {
	const account = dbOps.getAccount(accountId);
	if (!account) {
		throw new Error("Account not found");
	}

	const nextRouting = nextTeamRoutingConfig(
		config.getTeamRouting(),
		account,
		pooled,
	);
	config.setTeamRouting(teamRoutingFileConfig(nextRouting));
}

export async function removeAccount(name: string): Promise<void> {
	const dbOps = DatabaseFactory.getInstance();
	await cliCommands.removeAccount(dbOps, name);
}

export async function pauseAccount(
	name: string,
): Promise<{ success: boolean; message: string }> {
	const dbOps = DatabaseFactory.getInstance();
	const account = dbOps.getAccountByName(name);

	if (!account) {
		return {
			success: false,
			message: `Account '${name}' not found`,
		};
	}

	if (account.paused) {
		return {
			success: false,
			message: `Account '${name}' is already paused`,
		};
	}

	dbOps.pauseAccount(account.id);
	return {
		success: true,
		message: `Account '${name}' paused successfully`,
	};
}

export async function resumeAccount(
	name: string,
): Promise<{ success: boolean; message: string }> {
	const dbOps = DatabaseFactory.getInstance();
	const account = dbOps.getAccountByName(name);

	if (!account) {
		return {
			success: false,
			message: `Account '${name}' not found`,
		};
	}

	if (!account.paused) {
		return {
			success: false,
			message: `Account '${name}' is already resumed`,
		};
	}

	dbOps.resumeAccount(account.id);
	return {
		success: true,
		message: `Account '${name}' resumed successfully`,
	};
}
