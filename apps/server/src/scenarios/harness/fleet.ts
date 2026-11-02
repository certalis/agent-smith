import { DatabaseOperations } from "@ccflare/database";
import { durationMs, type FleetAccount } from "./scenario";

type SeedFleetOptions = {
	accounts: FleetAccount[];
	dbPath: string;
	defaultBaseUrl: string;
	now?: () => number;
};

export type SeededFleet = {
	accountIds: ReadonlyMap<string, string>;
	tokenToAccount: ReadonlyMap<string, string>;
};

export function seedFleet({
	accounts,
	dbPath,
	defaultBaseUrl,
	now = Date.now,
}: SeedFleetOptions): SeededFleet {
	const db = new DatabaseOperations(dbPath);
	const accountIds = new Map<string, string>();
	const tokenToAccount = new Map<string, string>();

	try {
		for (const spec of accounts) {
			const token = `tok-${spec.name}`;
			const provider = spec.provider ?? "claude-code";
			const account =
				spec.authMethod === "api_key"
					? db.createApiKeyAccount({
							name: spec.name,
							provider,
							apiKey: `key-${spec.name}`,
							baseUrl: spec.baseUrl ?? defaultBaseUrl,
						})
					: db.createOAuthAccount({
							name: spec.name,
							provider,
							accessToken: token,
							refreshToken: `refresh-${spec.name}`,
							expiresAt: now() + 60 * 60 * 1_000,
							accountUuid: spec.accountUuid,
							quotaState: spec.quotaState,
							baseUrl: spec.baseUrl ?? defaultBaseUrl,
							priority: spec.priority,
							switchThreshold: spec.switchThreshold,
						});

			if (spec.rateLimitedFor) {
				db.markAccountRateLimited(
					account.id,
					now() + durationMs(spec.rateLimitedFor),
				);
			}

			if (spec.activeSession) {
				db.resetAccountSession(account.id, now());
			}

			if (spec.paused) {
				db.pauseAccount(account.id);
			}

			accountIds.set(spec.name, account.id);
			tokenToAccount.set(
				spec.authMethod === "api_key" ? `key-${spec.name}` : token,
				spec.name,
			);
		}
	} finally {
		db.close();
	}

	return { accountIds, tokenToAccount };
}
