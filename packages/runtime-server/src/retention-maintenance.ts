import type { Config } from "@agent-smith/config";
import type { DatabaseOperations } from "@agent-smith/database";
import { Logger } from "@agent-smith/logger";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function removeExpiredRequests(
	config: Config,
	dbOps: DatabaseOperations,
	log: Logger,
	label: string,
): void {
	try {
		const payloadDays = config.getDataRetentionDays();
		const requestDays = config.getRequestRetentionDays();
		const { removedRequests, removedPayloads } = dbOps.cleanupOldRequests(
			payloadDays * DAY_MS,
			requestDays * DAY_MS,
		);
		log.info(
			`${label} cleanup removed ${removedRequests} requests and ${removedPayloads} payloads (payload=${payloadDays}d, requests=${requestDays}d)`,
		);
	} catch (err) {
		log.error(`${label} cleanup error: ${err}`);
	}
}

/**
 * Cleans up and compacts once at startup, then deletes expired rows every
 * interval so the database stops growing between restarts. The periodic run
 * only checkpoints the WAL: freed pages are reused without a VACUUM.
 */
export function startRetentionMaintenance(
	config: Config,
	dbOps: DatabaseOperations,
	intervalMs = RETENTION_CLEANUP_INTERVAL_MS,
): () => void {
	const log = new Logger("RetentionMaintenance");

	removeExpiredRequests(config, dbOps, log, "Startup");
	try {
		const { vacuumed, freeBytes, requiredBytes } = dbOps.compact();
		log.info(
			vacuumed
				? "Database compacted at startup"
				: `Startup VACUUM skipped: ${freeBytes} bytes free, ${requiredBytes} needed`,
		);
	} catch (err) {
		log.error(`Database compaction error: ${err}`);
	}

	const timer = setInterval(() => {
		removeExpiredRequests(config, dbOps, log, "Periodic");
		try {
			dbOps.checkpointWal();
		} catch (err) {
			log.error(`WAL checkpoint error: ${err}`);
		}
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
