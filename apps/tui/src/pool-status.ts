import { readStandaloneOptions } from "@agent-smith/config/standalone";
import { readPoolStatus } from "./core/pool-status";

try {
	console.log(
		JSON.stringify(await readPoolStatus(readStandaloneOptions(process.env))),
	);
} catch (error) {
	console.error(
		error instanceof Error ? error.message : "Pool status could not be read",
	);
	process.exitCode = 1;
}
