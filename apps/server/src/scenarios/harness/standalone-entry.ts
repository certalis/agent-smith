import { join } from "node:path";
import { startStandalone } from "@agent-smith/runtime-server/standalone";

const stateDir = process.env.AGENT_SMITH_STATE_DIR;
const poolEntry = process.env.AGENT_SMITH_SCENARIO_POOL_ENTRY;
if (!stateDir || !poolEntry)
	throw new Error("Missing standalone scenario paths");

try {
	const service = await startStandalone(
		{
			origin: "https://pool.example",
			port: 0,
			poolPort: 0,
			poolHost: "127.0.0.1",
			stateDir,
			socketPath: join(stateDir, "control.sock"),
			configPath: process.env.AGENT_SMITH_CONFIG_PATH ?? "",
			dbPath: process.env.AGENT_SMITH_DB_PATH ?? "",
			clientKeysFile: process.env.AGENT_SMITH_CLIENT_KEYS_FILE ?? "",
			adminKey: process.env.AGENT_SMITH_ADMIN_KEY ?? "",
			proxyKey: process.env.AGENT_SMITH_PROXY_KEY ?? "",
		},
		poolEntry,
	);
	service.pool.on("message", (message: unknown) => {
		if (
			message &&
			typeof message === "object" &&
			"type" in message &&
			message.type !== "ready"
		)
			process.send?.(message);
	});
	const stop = () => {
		void service.stop().finally(() => process.exit(0));
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	process.on("disconnect", stop);
	let stopping: Promise<void> | undefined;
	process.on("message", (message: { type: string; id: string }) => {
		void (async () => {
			if (message.type === "begin-stop") {
				const poolStopping = new Promise<void>((resolve) => {
					const onMessage = (reply: { type?: string }) => {
						if (reply.type !== "stopping") return;
						service.pool.off("message", onMessage);
						resolve();
					};
					service.pool.on("message", onMessage);
				});
				stopping = service.stop();
				await poolStopping;
				process.send?.({ type: "stopping", id: message.id });
			} else if (message.type === "await-stop") {
				if (!stopping) throw new Error("Standalone shutdown has not begun");
				await stopping;
				process.send?.({ type: "stopped", id: message.id }, () =>
					process.exit(0),
				);
			} else if (message.type === "terminate-pool") {
				service.pool.kill("SIGTERM");
				await service.exited;
				process.send?.({ type: "pool-exited", id: message.id });
			} else if (message.type === "stop") {
				await service.stop();
				process.send?.({ type: "stopped", id: message.id }, () =>
					process.exit(0),
				);
			} else service.pool.send(message);
		})().catch((error: unknown) =>
			process.send?.({
				type: "error",
				id: message.id,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	});
	process.send?.({ type: "ready", pid: process.pid, port: service.port });
} catch (error) {
	process.send?.({
		type: "error",
		error:
			error instanceof Error ? (error.stack ?? error.message) : String(error),
	});
	process.exitCode = 1;
}
