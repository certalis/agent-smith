import { isAbsolute } from "node:path";
import { stopAllOAuthCallbackForwarders } from "@agent-smith/api";
import { NETWORK, shutdown } from "@agent-smith/core";
import { DatabaseFactory } from "@agent-smith/database";
import { Logger, LogLevel } from "@agent-smith/logger";
import {
	terminateUsageWorker,
	waitForProxyBackgroundTasks,
	websocketProxyHandler,
} from "@agent-smith/proxy";
import { serve } from "bun";
import { bootstrapRuntime, logInitialAccountStatus } from "./bootstrap-runtime";
import { loadDashboardAssets, resetDashboardAssets } from "./dashboard-assets";
import { DeploymentDrain } from "./deployment-drain";
import { createServerFetchHandler } from "./fetch-handler";
import { createStartupBanner } from "./startup-banner";
import { runStartupMaintenance } from "./startup-maintenance";

// Bun honors this listener option for Unix sockets, but its bundled types omit it.
declare module "bun" {
	namespace Serve {
		interface UnixServeOptions<WebSocketData> {
			idleTimeout?: number;
		}
	}
}

const serverLog = new Logger("Server");
const lifecycleLog = new Logger("ServerLifecycle", LogLevel.INFO, {
	silentConsole: false,
});

// Module-level server instance
let serverInstance: ReturnType<typeof serve> | null = null;
let unixServerInstance: ReturnType<typeof serve> | null = null;
let stopRetentionJob: (() => void) | null = null;
let serverStopPromise: Promise<void> | null = null;
let deploymentDrain: DeploymentDrain | undefined;
let checkShutdownDrain: (() => void) | undefined;

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
		const activeUnixServer = unixServerInstance;
		deploymentDrain?.shutdown();
		const listeners = [activeUnixServer, activeServer].filter(
			(listener) => listener !== null,
		);
		// Leave cleanup time inside Render's fixed 30-second disk-backed grace.
		const shutdownDeadline = Date.now() + 25_000;
		try {
			await new Promise<void>((resolve) => {
				let timer: ReturnType<typeof setInterval> | undefined;
				const finish = () => {
					clearInterval(timer);
					resolve();
				};
				const check = () => {
					const pending = listeners.some(
						(listener) =>
							listener.pendingRequests > 0 || listener.pendingWebSockets > 0,
					);
					if (!pending) finish();
					else if (Date.now() >= shutdownDeadline) {
						lifecycleLog.warn(
							"Shutdown grace expired; closing remaining connections",
						);
						finish();
					}
				};
				checkShutdownDrain = check;
				// Keep both listeners available for retryable rejections while draining.
				timer = setInterval(check, 50);
				check();
			});
			// Bun 1.3.x cannot reliably force an already-started stop(false).
			// Call stop exactly once, after the wait or its deadline.
			const stopped = await Promise.allSettled(
				listeners.map((listener) => listener.stop(true)),
			);
			for (const result of stopped) {
				if (result.status === "rejected")
					errors.push(toError("Failed to stop listener", result.reason));
			}
		} finally {
			checkShutdownDrain = undefined;
			serverInstance = null;
			unixServerInstance = null;
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
	const drain = new DeploymentDrain(() => ({
		// Bun counts each response until it ends, including this control request.
		activeRequests: Math.max(
			0,
			(serverInstance?.pendingRequests ?? 0) +
				(unixServerInstance?.pendingRequests ?? 0) -
				1,
		),
		activeWebSockets:
			(serverInstance?.pendingWebSockets ?? 0) +
			(unixServerInstance?.pendingWebSockets ?? 0),
	}));
	deploymentDrain = drain;

	const {
		config,
		dbOps,
		log,
		apiRouter,
		exposureConfig,
		proxyContext,
		providerRegistry,
		runtimeConfig,
	} = bootstrapRuntime(port, serverLog, drain.control);

	stopRetentionJob = runStartupMaintenance(config, dbOps);

	const fetchHandler = createServerFetchHandler({
		apiRouter,
		exposureConfig,
		proxyContext,
		withDashboard,
		isDeploymentDraining: drain.isDraining,
	});
	try {
		if (options?.additionalUnixSocket) {
			unixServerInstance = serve({
				unix: options.additionalUnixSocket,
				idleTimeout: NETWORK.IDLE_TIMEOUT_MAX,
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
			checkShutdownDrain?.();
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
