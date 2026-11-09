import type { DatabaseOperations } from "@agent-smith/database";
import { analyzeDatabasePerformance } from "@agent-smith/database";

/**
 * Analyze query performance and index usage
 */
export function analyzePerformance(dbOps: DatabaseOperations): void {
	analyzeDatabasePerformance(dbOps);
}
