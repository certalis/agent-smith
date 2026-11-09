import { fileURLToPath } from "node:url";
import { readStandaloneOptions } from "@agent-smith/config/standalone";
import { startStandalone } from "@agent-smith/runtime-server/standalone";

try {
	const options = readStandaloneOptions(process.env);
	const service = await startStandalone(
		options,
		fileURLToPath(new URL("./pool.js", import.meta.url)),
	);
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		void service.stop().then(
			() => process.exit(0),
			() => process.exit(1),
		);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	console.log(`Agent Smith HTTPS entrance ready on port ${options.port}`);
	await service.exited;
	if (!stopping) {
		console.error(
			"Agent Smith private pool exited; stopping the public entrance",
		);
		process.exitCode = 1;
	}
} catch {
	console.error(
		"Agent Smith standalone startup failed; check origin, private state and key permissions",
	);
	process.exitCode = 1;
}
