import type { Config } from "@agent-smith/config";
import type { DatabaseOperations } from "@agent-smith/database";
import type { ProviderRegistry } from "@agent-smith/providers";
import type {
	Account,
	AccountProvider,
	AccountSwitchThreshold,
	AuthMethod,
	CallerPoolStatus,
	PoolStatus,
	ProviderWire,
	RuntimeHealth,
} from "@agent-smith/types";

export interface AccountResponse {
	id: string;
	name: string;
	provider: AccountProvider;
	providerDisabled: boolean;
	resetCreditsSupported: boolean;
	auth_method: AuthMethod;
	base_url: string | null;
	requestCount: number;
	totalRequests: number;
	lastUsed: string | null;
	created: string;
	weight: number;
	priority: number;
	switchThreshold: AccountSwitchThreshold | null;
	errorReason: string | null;
	paused: boolean;
	tokenStatus: "valid" | "expired";
	tokenExpiresAt: string | null;
	rateLimitStatus: {
		code: string;
		isLimited: boolean;
		until: string | null;
	};
	rateLimitReset: string | null;
	rateLimitRemaining: number | null;
	sessionInfo: {
		active: boolean;
		startedAt: string | null;
		requestCount: number;
	};
}

export interface APIContext {
	deploymentDrain?: (action: "start" | "status" | "resume") => {
		draining: boolean;
		expiresAt: number | null;
		activeRequests: number;
		activeWebSockets: number;
	};
	enrollmentOrigin?: string;
	now?: () => number;
	config: Config;
	dbOps: DatabaseOperations;
	providerRegistry: ProviderRegistry;
	getProviders: () => string[];
	getRuntimeHealth?: () => RuntimeHealth;
	getPoolStatus?: (
		provider: AccountProvider,
		model?: string,
	) => PoolStatus | Promise<PoolStatus>;
	getCallerPoolStatus?: (
		pool: ProviderWire,
		model: string | undefined,
		callerId: string,
	) => CallerPoolStatus | null | Promise<CallerPoolStatus | null>;
	callerForDeviceKey?: (key: string | null) => string | undefined;
	getAccountAccessToken?: (account: Account) => Promise<string>;
}
