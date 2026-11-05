import { APIRouter } from "@ccflare/api";
import { Config, type RuntimeConfig } from "@ccflare/config";
import {
	container,
	registerDisposable,
	SERVICE_KEYS,
	setPricingLogger,
	TIME_CONSTANTS,
} from "@ccflare/core";
import type { DatabaseOperations } from "@ccflare/database";
import { AsyncDbWriter, DatabaseFactory } from "@ccflare/database";
import { Logger } from "@ccflare/logger";
import {
	createConfiguredProviderRegistry,
	type ProviderRegistry,
} from "@ccflare/providers";
import {
	getPoolStatus,
	getUsageWorker,
	getUsageWorkerHealth,
	getValidAccessToken,
	OutsideSpendTracker,
	type ProxyContext,
	QuotaHold,
	QuotaProbe,
	SeatAlerts,
	SessionStrategy,
	TeamAdmission,
	TeamRouter,
} from "@ccflare/proxy";
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
): void {
	config.on("change", (change: { key?: string }) => {
		if (change.key === "lb_strategy") {
			log.info("Strategy configuration changed");
			const newStrategyName = config.getStrategy();
			if (newStrategyName === "session") {
				const strategy = new SessionStrategy();
				strategy.initialize(dbOps);
				proxyContext.strategy = strategy;
			}
		}
		if (change.key === "team_routing") {
			runtimeConfig.teamRouting = config.getTeamRouting();
			quotaProbe.reschedule();
			log.info("Team routing configuration changed");
		}
	});
}

export function bootstrapRuntime(
	port: number,
	serverLog: Logger,
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

	const apiRouter = new APIRouter({
		enrollmentOrigin: process.env.CF_ENROLLMENT_ORIGIN,
		config,
		dbOps,
		providerRegistry,
		getProviders: () => providerRegistry.listProviders(),
		getPoolStatus: (provider, model) =>
			getPoolStatus(provider, model, {
				dbOps,
				runtime: runtimeConfig,
				providerRegistry,
			}),
		getRuntimeHealth: () => ({
			asyncWriter: {
				healthy: asyncWriter.isHealthy(),
				failureCount: asyncWriter.getFailureCount(),
				queuedJobs: asyncWriter.getQueueSize(),
			},
			usageWorker: getUsageWorkerHealth(),
		}),
	});
	const exposureConfig = createExposureConfig(config);

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
	const quotaProbe = new QuotaProbe(
		() => config.getTeamRouting(),
		dbOps,
		outsideSpendTracker,
		providerRegistry,
		async (account) => {
			const provider = providerRegistry.getProvider(account.provider);
			if (!provider) return null;
			return await getValidAccessToken(account, {
				...proxyContext,
				provider,
				providerName: account.provider,
				upstreamPath: "/",
			});
		},
	);
	quotaProbe.start();
	registerDisposable(quotaProbe);

	wireStrategyHotReload(
		config,
		log,
		dbOps,
		proxyContext,
		runtimeConfig,
		quotaProbe,
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
