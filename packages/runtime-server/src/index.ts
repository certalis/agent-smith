import { isAbsolute } from "node:path";
import { stopAllOAuthCallbackForwarders } from "@ccflare/api";
import { NETWORK, shutdown } from "@ccflare/core";
import { DatabaseFactory } from "@ccflare/database";
import { Logger, LogLevel } from "@ccflare/logger";
import {
	terminateUsageWorker,
	waitForProxyBackgroundTasks,
	websocketProxyHandler,
} from "@ccflare/proxy";
import { serve } from "bun";
import { bootstrapRuntime, logInitialAccountStatus } from "./bootstrap-runtime";
import { loadDashboardAssets, resetDashboardAssets } from "./dashboard-assets";
import { createServerFetchHandler } from "./fetch-handler";
import { createStartupBanner } from "./startup-banner";
import { runStartupMaintenance } from "./startup-maintenance";

const serverLog = new Logger("Server");
const lifecycleLog = new Logger("ServerLifecycle", LogLevel.INFO, {
	silentConsole: false,
});

// Module-level server instance
let serverInstance: ReturnType<typeof serve> | null = null;
let additionalServerInstances: Array<ReturnType<typeof serve>> = [];
let unixServerInstance: ReturnType<typeof serve> | null = null;
let stopRetentionJob: (() => void) | null = null;
let serverStopPromise: Promise<void> | null = null;

export interface ServerHandle {
	port: number;
	stop: () => Promise<void>;
	advanceRoutingClock?: () => void;
}

export interface StartServerOptions {
	port?: number;
	withDashboard?: boolean;
	additionalUnixSocket?: string;
}

function stopRetentionMaintenance(): void {
	if (stopRetentionJob) {
		stopRetentionJob();
		stopRetentionJob = null;
	}
}

function toError(scope: string, error: unknown): Error {
	if (error instanceof Error) {
		return new Error(`${scope}: ${error.message}`);
	}

	return new Error(`${scope}: ${String(error)}`);
}

function resetServerRuntimeState(): void {
	resetDashboardAssets();
	stopAllOAuthCallbackForwarders();
	DatabaseFactory.reset();
}

async function stopServerRuntime(): Promise<void> {
	if (serverStopPromise) {
		return serverStopPromise;
	}

	serverStopPromise = (async () => {
		const errors: Error[] = [];
		const activeServer = serverInstance;
		const activeAdditionalServers = additionalServerInstances;
		const activeUnixServer = unixServerInstance;
		serverInstance = null;
		additionalServerInstances = [];
		unixServerInstance = null;

		try {
			await activeUnixServer?.stop(true);
		} catch (error) {
			errors.push(toError("Failed to stop Unix server", error));
		}

		try {
			await activeServer?.stop(true);
		} catch (error) {
			errors.push(toError("Failed to stop Bun server", error));
		}

		for (const [index, server] of activeAdditionalServers.entries()) {
			try {
				await server.stop(true);
			} catch (error) {
				errors.push(
					toError(`Failed to stop additional Bun server ${index + 1}`, error),
				);
			}
		}

		stopRetentionMaintenance();

		try {
			await waitForProxyBackgroundTasks();
		} catch (error) {
			errors.push(toError("Failed to drain proxy background tasks", error));
		}

		try {
			await terminateUsageWorker();
		} catch (error) {
			errors.push(toError("Failed to stop usage worker", error));
		}

		try {
			await shutdown();
		} catch (error) {
			errors.push(toError("Failed to shutdown runtime disposables", error));
		}

		try {
			resetServerRuntimeState();
		} catch (error) {
			errors.push(toError("Failed to reset runtime state", error));
		}

		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				"Errors occurred during server shutdown",
			);
		}
	})();

	try {
		await serverStopPromise;
	} finally {
		serverStopPromise = null;
	}
}

export { createServerFetchHandler } from "./fetch-handler";
export { createStartupBanner } from "./startup-banner";

// Export for programmatic use
export default function startServer(
	options?: StartServerOptions,
): ServerHandle {
	if (
		options?.additionalUnixSocket !== undefined &&
		!isAbsolute(options.additionalUnixSocket)
	) {
		throw new Error("Additional Unix socket must be an absolute path");
	}
	// Return existing server if already running
	if (serverInstance) {
		return {
			port: serverInstance.port ?? NETWORK.DEFAULT_PORT,
			stop: () => stopServerRuntime(),
			advanceRoutingClock: () => {},
		};
	}

	const { port = NETWORK.DEFAULT_PORT, withDashboard = true } = options || {};

	if (withDashboard) {
		loadDashboardAssets();
	}

	const {
		config,
		dbOps,
		log,
		apiRouter,
		exposureConfig,
		proxyContext,
		providerRegistry,
		runtimeConfig,
	} = bootstrapRuntime(port, serverLog);

	stopRetentionJob = runStartupMaintenance(config, dbOps);

	const fetchHandler = createServerFetchHandler({
		apiRouter,
		exposureConfig,
		proxyContext,
		withDashboard,
	});
	try {
		if (options?.additionalUnixSocket) {
			unixServerInstance = serve({
				unix: options.additionalUnixSocket,
				fetch: fetchHandler,
				websocket: websocketProxyHandler,
			});
		}
		serverInstance = serve({
			hostname: exposureConfig.bindHost,
			port: runtimeConfig.port,
			idleTimeout: NETWORK.IDLE_TIMEOUT_MAX,
			fetch: fetchHandler,
			websocket: websocketProxyHandler,
		});
		const activePort = serverInstance.port ?? runtimeConfig.port;
		for (const hostname of exposureConfig.bindHosts.slice(1)) {
			additionalServerInstances.push(
				serve({
					hostname,
					port: activePort,
					idleTimeout: NETWORK.IDLE_TIMEOUT_MAX,
					fetch: fetchHandler,
					websocket: websocketProxyHandler,
				}),
			);
		}
	} catch (error) {
		void stopServerRuntime().catch(() => {
			lifecycleLog.error("Failed to clean up after listener startup failure");
		});
		throw error;
	}
	const activePort = serverInstance.port ?? runtimeConfig.port;

	lifecycleLog.info(
		createStartupBanner({
			version: process.env.npm_package_version || "1.0.0",
			port: activePort,
			withDashboard,
			strategy: config.getStrategy(),
			providers: providerRegistry.listProviders(),
		}),
	);

	logInitialAccountStatus(log, dbOps);

	return {
		port: activePort,
		stop: () => stopServerRuntime(),
		advanceRoutingClock: () => {
			proxyContext.teamAdmission?.advance();
			proxyContext.quotaHold?.advance();
		},
	};
}

// Graceful shutdown handler
async function handleGracefulShutdown(signal: string) {
	lifecycleLog.info(`Received ${signal}, shutting down gracefully`);
	try {
		await stopServerRuntime();
		lifecycleLog.info("Shutdown complete");
		process.exit(0);
	} catch (error) {
		lifecycleLog.error("Error during shutdown", error);
		process.exit(1);
	}
}

// Register signal handlers
process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));

// Run server if this is the main entry point
if (import.meta.main) {
	startServer();
}
