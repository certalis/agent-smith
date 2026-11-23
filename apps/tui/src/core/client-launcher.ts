import { launchConfiguredClient } from "./local-routing";

try {
	const [configPath, tool, target, claudeCompanionDir, ...args] =
		process.argv.slice(2);
	if (!configPath || !tool || !target || claudeCompanionDir === undefined)
		throw new Error("Invalid Agent Smith client launcher");
	process.exitCode = await launchConfiguredClient(
		configPath,
		tool,
		target,
		claudeCompanionDir,
		args,
	);
} catch (error) {
	console.error(
		error instanceof Error
			? error.message
			: "Agent Smith could not start the client",
	);
	process.exitCode = 1;
}
