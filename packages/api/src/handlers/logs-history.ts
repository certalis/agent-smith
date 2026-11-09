import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@agent-smith/http";
import { Logger, logFileWriter } from "@agent-smith/logger";

const log = new Logger("LogsHistoryHandler");

/**
 * Create a logs history handler to fetch past logs
 */
export function createLogsHistoryHandler() {
	return async (): Promise<Response> => {
		try {
			// Get the last 1000 logs by default
			const logs = await logFileWriter.readLogs(1000);

			return jsonResponse(logs);
		} catch (error) {
			log.error("Failed to fetch log history", error);
			return errorResponse(InternalServerError("Failed to fetch log history"));
		}
	};
}
