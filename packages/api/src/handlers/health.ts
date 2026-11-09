import type { Config } from "@agent-smith/config";
import type { DatabaseOperations } from "@agent-smith/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@agent-smith/http";
import { Logger } from "@agent-smith/logger";
import type { HealthResponse, RuntimeHealth } from "@agent-smith/types";

const log = new Logger("HealthHandler");

/**
 * Create a health check handler
 */
export function createHealthHandler(
	dbOps: DatabaseOperations,
	config: Config,
	getProviders: () => string[],
	getRuntimeHealth?: () => RuntimeHealth,
) {
	return (): Response => {
		try {
			const response: HealthResponse = {
				status: "ok",
				accounts: dbOps.countAccounts(),
				timestamp: new Date().toISOString(),
				strategy: config.getStrategy(),
				providers: getProviders(),
				runtime: getRuntimeHealth?.(),
			};

			return jsonResponse(response);
		} catch (error) {
			log.error("Failed to compute health response", error);
			return errorResponse(
				InternalServerError("Failed to compute health response"),
			);
		}
	};
}
