import { type APIContext, APIRouter } from "@agent-smith/api";
import { Config, type RuntimeConfig } from "@agent-smith/config";
import {
	container,
	registerDisposable,
	SERVICE_KEYS,
	setPricingLogger,
	TIME_CONSTANTS,
} from "@agent-smith/core";
import type { DatabaseOperations } from "@agent-smith/database";
import { AsyncDbWriter, DatabaseFactory } from "@agent-smith/database";
import { Logger } from "@agent-smith/logger";
import { type PoolContext, ProviderSupply } from "@agent-smith/pool";
import {
	createConfiguredProviderRegistry,
	type ProviderRegistry,
} from "@agent-smith/providers";
import {
	createSupplyExecutorFactory,
	getCallerPoolStatus,
	getPoolStatus,
	getUsageWorker,
	getUsageWorkerHealth,
	getValidAccessToken,
	OutsideSpendTracker,
	type ProxyContext,
	QuotaHold,
	QuotaProbe,
	SeatAlerts,
	type SeatTokenReader,
	SessionStrategy,
	TeamAdmission,
	TeamRouter,
	WindowWarmup,
} from "@agent-smith/proxy";
import { deviceKeyName } from "./device-keys";
import { createExposureConfig, type ExposureConfig } from "./exposure";

export type BootstrappedRuntime = {
	config: Config;
	dbOps: DatabaseOperations;
	log: Logger;
	asyncWriter: AsyncDbWriter;
	apiRouter: APIRouter;
	exposureConfig: ExposureConfig;
	proxyContext: ProxyContext;
	providerRegistry: ProviderRegistry;
	runtimeConfig: RuntimeConfig;
};

function createRuntimeConfig(config: Config, port: number): RuntimeConfig {
	return {
		blockWhenAllFull: config.getBlockWhenAllFull(),
		clientId: config.get(
			"client_id",
			"9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		) as string,
		maxBodyBytes: config.get("max_body_bytes", 64 * 1024 * 1024) as number,
		requestScopedRetryDelayMs: config.get(
			"request_scoped_429_retry_delay_ms",
			2000,
		) as number,
		quotaThreshold: config.get("quota_threshold", 0.98) as number,
		retry: {
			attempts: config.get("retry_attempts", 3) as number,
			delayMs: config.get("retry_delay_ms", 1000) as number,
			backoff: config.get("retry_backoff", 2) as number,
		},
		sessionDurationMs: config.get(
			"session_duration_ms",
			TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
		) as number,
		port,
		storeRequestPayloads: config.storesRequestPayloads(),
		teamRouting: config.getTeamRouting(),
	};
}

function wireStrategyHotReload(
	config: Config,
	log: Logger,
	dbOps: DatabaseOperations,
	proxyContext: ProxyContext,
	runtimeConfig: RuntimeConfig,
	quotaProbe: QuotaProbe,
	windowWarmup: WindowWarmup,
	poolContext: PoolContext,
): void {
	config.on("change", (change: { key?: string }) => {
		if (change.key === "lb_strategy") {
			log.info("Strategy configuration changed");
			const newStrategyName = config.getStrategy();
			if (newStrategyName === "session") {
				const strategy = new SessionStrategy();
				strategy.initialize(dbOps);
				proxyContext.strategy = strategy;
				poolContext.strategy = strategy;
			}
		}
		if (change.key === "data_retention_days") {
			runtimeConfig.storeRequestPayloads = config.storesRequestPayloads();
		}
		if (change.key === "team_routing") {
			runtimeConfig.teamRouting = config.getTeamRouting();
			quotaProbe.reschedule();
			windowWarmup.reschedule();
			log.info("Team routing configuration changed");
		}
	});
}

/** The seat jobs that read or start quota windows on no client's request. */
function startSeatSchedulers(
	config: Config,
	proxyContext: ProxyContext,
	outsideSpendTracker: OutsideSpendTracker,
): { quotaProbe: QuotaProbe; windowWarmup: WindowWarmup } {
	const { dbOps, providerRegistry, runtime } = proxyContext;
	const readSeatToken: SeatTokenReader = async (account) => {
		const provider = providerRegistry.getProvider(account.provider);
		if (!provider) return null;
		return await getValidAccessToken(account, {
			...proxyContext,
			provider,
			providerName: account.provider,
			upstreamPath: "/",
		});
	};
	const quotaProbe = new QuotaProbe(
		() => config.getTeamRouting(),
		dbOps,
		outsideSpendTracker,
		providerRegistry,
		readSeatToken,
	);
	const windowWarmup = new WindowWarmup(
		() => runtime,
		dbOps,
		outsideSpendTracker,
		providerRegistry,
		readSeatToken,
	);
	for (const scheduler of [quotaProbe, windowWarmup]) {
		scheduler.start();
		registerDisposable(scheduler);
	}
	return { quotaProbe, windowWarmup };
}

export function bootstrapRuntime(
	port: number,
	serverLog: Logger,
	deploymentDrain?: APIContext["deploymentDrain"],
): BootstrappedRuntime {
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	container.registerInstance(SERVICE_KEYS.Logger, serverLog);

	const config = container.resolve<Config>(SERVICE_KEYS.Config);
	const runtimeConfig = createRuntimeConfig(config, port);
	const providerRegistry = createConfiguredProviderRegistry(
		config.getProviderConfigs(),
		config.getProviderPools(),
	);

	DatabaseFactory.initialize(undefined, {
		sessionDurationMs: runtimeConfig.sessionDurationMs,
	});

	const dbOps = DatabaseFactory.getInstance();
	const log = container.resolve<Logger>(SERVICE_KEYS.Logger);
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

	const asyncWriter = new AsyncDbWriter();
	container.registerInstance(SERVICE_KEYS.AsyncWriter, asyncWriter);
	registerDisposable(asyncWriter);

	const pricingLogger = new Logger("Pricing");
	container.registerInstance(SERVICE_KEYS.PricingLogger, pricingLogger);
	setPricingLogger(pricingLogger);

	const exposureConfig = createExposureConfig(config);
	const apiRouter = new APIRouter({
		deploymentDrain,
		enrollmentOrigin: process.env.AGENT_SMITH_ENROLLMENT_ORIGIN,
		config,
		dbOps,
		providerRegistry,
		getProviders: () => providerRegistry.listProviders(),
		getAccountAccessToken: async (account) => {
			const provider = providerRegistry.getProvider(account.provider);
			if (!provider) throw new Error("Provider unavailable");
			return getValidAccessToken(account, {
				...proxyContext,
				provider,
				providerName: account.provider,
				upstreamPath: "/",
			});
		},
		getPoolStatus: async (provider, model) => {
			const supply = proxyContext.routedProviders?.get(provider);
			if (!supply)
				return getPoolStatus(provider, model, {
					dbOps,
					runtime: runtimeConfig,
					providerRegistry,
				});
			const url = new URL(`http://localhost/v1/${provider}/`);
			const status = await supply.status({
				scope: { kind: "direct", provider },
				edge: {
					method: "GET",
					url,
					headers: new Headers(),
					body: null,
					meta: {
						id: "pool-status",
						method: "GET",
						path: url.pathname,
						timestamp: Date.now(),
					},
				},
				model,
				sessionId: null,
				openingDigest: null,
				apiKeyAccounts: false,
				inlineRateLimitRetry: false,
				signal: new AbortController().signal,
			});
			return {
				version: 1,
				provider,
				routingEnabled: runtimeConfig.teamRouting.enabled,
				eligibleAccounts: status.servableSeats,
				retryAtMs: status.retryAt,
				holdSeconds: runtimeConfig.teamRouting.holdSeconds,
				admissionWaitMs: status.admissionWaitMs,
			};
		},
		getCallerPoolStatus: (pool, model, callerId) =>
			getCallerPoolStatus(pool, model, callerId, {
				dbOps,
				runtime: runtimeConfig,
				providerRegistry,
			}),
		callerForDeviceKey: (key) =>
			deviceKeyName(key, exposureConfig.clientKeysFile),
		getRuntimeHealth: () => ({
			asyncWriter: {
				healthy: asyncWriter.isHealthy(),
				failureCount: asyncWriter.getFailureCount(),
				queuedJobs: asyncWriter.getQueueSize(),
			},
			usageWorker: getUsageWorkerHealth(),
		}),
	});

	const strategy = new SessionStrategy();
	strategy.initialize(dbOps);

	const teamRouter = new TeamRouter();
	const teamAdmission = new TeamAdmission();
	const quotaHold = new QuotaHold();
	const outsideSpendTracker = new OutsideSpendTracker();
	registerDisposable(quotaHold);
	const proxyContext: ProxyContext = {
		strategy,
		dbOps,
		runtime: runtimeConfig,
		providerRegistry,
		refreshInFlight: new Map(),
		messageThreads: new Map(),
		quotaProbeAt: new Map(),
		teamRouter,
		teamAdmission,
		quotaHold,
		outsideSpendTracker,
		seatAlerts: new SeatAlerts(config.getAlerts()),
		asyncWriter,
		usageWorker: getUsageWorker(),
	};
	const poolContext: PoolContext = { ...proxyContext };
	const createExecutor = createSupplyExecutorFactory(proxyContext);
	proxyContext.routedProviders = new Map(
		providerRegistry.listProviders().flatMap((name) => {
			const provider = providerRegistry.getProvider(name);
			if (!provider) return [];
			return [
				[
					name,
					new ProviderSupply(provider, poolContext, {
						mapModel: (model) =>
							providerRegistry.mapModel(name, model) ??
							(model === undefined ? undefined : null),
						createExecutor,
					}),
				] as const,
			];
		}),
	);
	const { quotaProbe, windowWarmup } = startSeatSchedulers(
		config,
		proxyContext,
		outsideSpendTracker,
	);

	wireStrategyHotReload(
		config,
		log,
		dbOps,
		proxyContext,
		runtimeConfig,
		quotaProbe,
		windowWarmup,
		poolContext,
	);

	return {
		config,
		dbOps,
		log,
		asyncWriter,
		apiRouter,
		exposureConfig,
		proxyContext,
		providerRegistry,
		runtimeConfig,
	};
}

export function logInitialAccountStatus(
	log: Logger,
	dbOps: DatabaseOperations,
): void {
	const accounts = dbOps.getAllAccounts();
	const activeAccounts = accounts.filter(
		(account) =>
			!account.paused &&
			(!account.expires_at || account.expires_at > Date.now()),
	);

	log.info(
		`Loaded ${accounts.length} accounts (${activeAccounts.length} active)`,
	);

	if (activeAccounts.length === 0) {
		log.warn(
			"No active accounts available - requests will be refused with a 503 until an account is added",
		);
	}
}
