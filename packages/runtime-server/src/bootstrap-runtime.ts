import { type APIContext, APIRouter } from "@agent-smith/api";
import type { RouteRequest } from "@agent-smith/capacity";
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
import {
	getValidAccessToken,
	OutsideSpendTracker,
	type PoolContext,
	QuotaProbe,
	SeatAlerts,
	type SeatTokenReader,
	TeamAdmission,
	TeamRouter,
	WindowWarmup,
} from "@agent-smith/pool";
import {
	createConfiguredProviderRegistry,
	type ProviderRegistry,
} from "@agent-smith/providers";
import {
	createProviderSupplies,
	getUsageWorker,
	getUsageWorkerHealth,
	hasOrderedProviderFallback,
	type ProxyContext,
	QuotaHold,
	SessionStrategy,
	SqliteConversationProviderRoutingStore,
} from "@agent-smith/proxy";
import { getCallerPoolStatus, Router } from "@agent-smith/routing";
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
	poolContext: PoolContext;
	providerRegistry: ProviderRegistry;
	runtimeConfig: RuntimeConfig;
};

type StatusRequest = RouteRequest;

function createStatusRequest(
	scope: StatusRequest["scope"],
	url: URL,
	model: string | undefined,
	callerId?: string,
	apiKeyAccounts = false,
): StatusRequest {
	return {
		scope,
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
		...(callerId !== undefined && { callerId }),
		sessionId: null,
		openingDigest: null,
		apiKeyAccounts,
		inlineRateLimitRetry: false,
		signal: new AbortController().signal,
	};
}

function createRuntimeConfig(config: Config, port: number): RuntimeConfig {
	return {
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
		routing: config.getRouting(),
		providerPools: config.getProviderPoolSettings(),
	};
}

function wireStrategyHotReload(
	config: Config,
	log: Logger,
	dbOps: DatabaseOperations,
	proxyContext: ProxyContext,
	runtimeConfig: RuntimeConfig,
	quotaProbe: Pick<QuotaProbe, "reschedule">,
	windowWarmup: Pick<WindowWarmup, "reschedule">,
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
		if (change.key === "providers" || change.key === "routing") {
			runtimeConfig.providerPools = config.getProviderPoolSettings();
			runtimeConfig.routing = config.getRouting();
			proxyContext.providerRegistry.setProviderPools(config.getProviderPools());
			quotaProbe.reschedule();
			windowWarmup.reschedule();
			log.info("Provider pool or routing configuration changed");
		}
	});
}

/** The seat jobs that read or start quota windows on no client's request. */
function startSeatSchedulers(
	config: Config,
	poolContext: PoolContext,
	outsideSpendTracker: OutsideSpendTracker,
): {
	quotaProbe: Pick<QuotaProbe, "reschedule">;
	windowWarmup: Pick<WindowWarmup, "reschedule">;
} {
	const { dbOps, providerRegistry, runtime } = poolContext;
	const readSeatToken: SeatTokenReader = async (account) => {
		const provider = providerRegistry.getProvider(account.provider);
		if (!provider) return null;
		return await getValidAccessToken(account, {
			...poolContext,
			runtime: {
				...poolContext.runtime,
				pool: config.getTeamRouting(account.provider),
			},
			provider,
			providerName: account.provider,
			upstreamPath: "/",
		});
	};
	const quotaProbes: QuotaProbe[] = [];
	const warmups: WindowWarmup[] = [];
	for (const name of providerRegistry.listProviders()) {
		const store = {
			getAllAccounts: () =>
				dbOps.getAllAccounts().filter((account) => account.provider === name),
			updateAccountQuotaState: dbOps.updateAccountQuotaState.bind(dbOps),
			getEnrollmentContact: dbOps.getEnrollmentContact.bind(dbOps),
		};
		const probe = new QuotaProbe(
			() => config.getTeamRouting(name),
			store,
			outsideSpendTracker,
			providerRegistry,
			readSeatToken,
		);
		const warmup = new WindowWarmup(
			() => ({
				quotaThreshold: runtime.quotaThreshold,
				pool: config.getTeamRouting(name),
			}),
			store,
			outsideSpendTracker,
			providerRegistry,
			readSeatToken,
		);
		quotaProbes.push(probe);
		warmups.push(warmup);
		for (const scheduler of [probe, warmup]) {
			scheduler.start();
			registerDisposable(scheduler);
		}
	}
	return {
		quotaProbe: {
			reschedule: () =>
				quotaProbes.forEach((probe) => {
					probe.reschedule();
				}),
		},
		windowWarmup: {
			reschedule: () =>
				warmups.forEach((warmup) => {
					warmup.reschedule();
				}),
		},
	};
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
				...poolContext,
				runtime: {
					...poolContext.runtime,
					pool: config.getTeamRouting(account.provider),
				},
				provider,
				providerName: account.provider,
				upstreamPath: "/",
			});
		},
		getPoolStatus: async (provider, model) => {
			const supply = proxyContext.routedProviders.get(provider);
			if (!supply) throw new Error("Provider supply unavailable");
			const url = new URL(`http://localhost/v1/${provider}/`);
			const status = await supply.status(
				createStatusRequest({ kind: "direct", provider }, url, model),
			);
			return {
				version: 1,
				provider,
				routingEnabled: status.poolEnabled,
				eligibleAccounts: status.servableSeats,
				retryAtMs: status.retryAt,
				holdSeconds: runtimeConfig.routing.holdSeconds,
				admissionWaitMs: status.admissionWaitMs,
			};
		},
		getCallerPoolStatus: async (pool, model, callerId) => {
			const members = providerRegistry.poolCapacityMembers(pool, model);
			const url = new URL(`http://localhost/v1/pool/${pool}/`);
			const providers = members.map(({ provider }) => {
				const supply = proxyContext.routedProviders.get(provider.name);
				if (!supply) throw new Error("Provider supply unavailable");
				return supply;
			});
			return getCallerPoolStatus({
				route: createStatusRequest(
					{ kind: "pool-route", wire: pool },
					url,
					model,
					callerId,
				),
				providers,
				orderedFallback: hasOrderedProviderFallback(
					runtimeConfig.routing,
					callerId,
				),
				apiKeyAccounts:
					runtimeConfig.routing.apiKeyAccounts === "everyone" ||
					hasOrderedProviderFallback(runtimeConfig.routing, callerId),

				holdSeconds: runtimeConfig.routing.holdSeconds,
			});
		},
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
	const poolContext: PoolContext = {
		strategy,
		dbOps,
		runtime: runtimeConfig,
		providerRegistry,
		refreshInFlight: new Map(),
		messageThreads: new Map(),
		quotaProbeAt: new Map(),
		teamRouter,
		teamAdmission,
		outsideSpendTracker,
		seatAlerts: new SeatAlerts(config.getAlerts()),
		asyncWriter,
	};
	const proxyContext: ProxyContext = {
		strategy,
		dbOps,
		runtime: runtimeConfig,
		providerRegistry,
		asyncWriter,
		routedProviders: new Map(),
		router: new Router(new SqliteConversationProviderRoutingStore(dbOps)),
		quotaHold,
		usageWorker: getUsageWorker(),
	};
	proxyContext.routedProviders = createProviderSupplies(
		poolContext,
		proxyContext,
	);
	const { quotaProbe, windowWarmup } = startSeatSchedulers(
		config,
		poolContext,
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
		poolContext,
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
