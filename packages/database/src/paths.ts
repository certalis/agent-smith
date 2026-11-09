import { join } from "node:path";
import { getPlatformConfigDir } from "@agent-smith/config";

export function resolveDbPath(): string {
	// Check for explicit DB path from environment
	const explicitPath = process.env.AGENT_SMITH_DB_PATH;
	if (explicitPath) {
		return explicitPath;
	}

	// Use common platform config directory
	const configDir = getPlatformConfigDir();
	return join(configDir, "agent-smith.db");
}
