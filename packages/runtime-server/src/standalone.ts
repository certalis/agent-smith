import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import {
	poolEnvironment,
	type StandaloneOptions,
} from "@agent-smith/config/standalone";
import { createProxyEdgeHandler } from "./proxy-edge";

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Agent Smith lifecycle deadline exceeded")),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Refuse unsafe state rather than silently migrating or changing its ownership. */
export async function prepareStandaloneState(
	options: StandaloneOptions,
): Promise<void> {
	await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
	const directory = await lstat(options.stateDir);
	const owned = (uid: number) => uid === 0 || uid === process.getuid?.();
	if (
		!directory.isDirectory() ||
		(directory.mode & 0o077) !== 0 ||
		!owned(directory.uid)
	) {
		throw new Error("Agent Smith requires an owner-only state directory");
	}
	for (const path of [
		options.configPath,
		options.dbPath,
		options.clientKeysFile,
	]) {
		const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (
			stat &&
			(!stat.isFile() || (stat.mode & 0o077) !== 0 || !owned(stat.uid))
		) {
			throw new Error("Agent Smith requires owner-only regular state files");
		}
	}
	const socket = await lstat(options.socketPath).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		},
	);
	if (!socket) return;
	if (!socket.isSocket())
		throw new Error("Agent Smith control path is not a socket");
	const active = await bounded(
		new Promise<boolean>((resolve, reject) => {
			const probe = createConnection(options.socketPath);
			probe.once("connect", () => {
				probe.destroy();
				resolve(true);
			});
			probe.once("error", (error: NodeJS.ErrnoException) => {
				probe.destroy();
				if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
					resolve(false);
				else reject(error);
			});
		}),
		2_000,
	);
	if (active) throw new Error("Agent Smith pool is already running");
	await unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

/** One public inference entrance supervises exactly one private Bun pool. */
export async function startStandalone(
	options: StandaloneOptions,
	poolEntry: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	process.umask(0o077);
	await prepareStandaloneState(options);
	const edge = createProxyEdgeHandler({
		...options,
		enrollmentOrigin: env.AGENT_SMITH_ENROLLMENT_ORIGIN,
	});
	const server = createServer((req, res) => {
		if (
			req.method === "GET" &&
			req.url === "/readyz" &&
			req.headers.host === new URL(options.origin).host
		) {
			res.writeHead(200, {
				"content-type": "text/plain",
				"cache-control": "no-store",
			});
			res.end("ready\n");
			return;
		}
		edge(req, res);
	});
	server.on("checkContinue", (req, res) => edge(req, res));
	const child = spawn("bun", [poolEntry], {
		env: poolEnvironment(options, env),
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	});
	let stopping = false;
	let exited = false;
	const closed = new Promise<void>((resolve) =>
		child.once("close", () => {
			exited = true;
			if (!stopping) {
				server.close();
				server.closeAllConnections();
			}
			resolve();
		}),
	);
	let stopPromise: Promise<void> | undefined;
	const stop = () =>
		(stopPromise ??= (async () => {
			stopping = true;
			const publicClosed = new Promise<void>((resolve) =>
				server.close(() => resolve()),
			);
			// Both listeners drain together, not 25 seconds each in sequence.
			if (!exited) child.kill("SIGTERM");
			try {
				await bounded(Promise.all([publicClosed, closed]), 28_000);
			} catch {
				server.closeAllConnections();
				if (!exited) child.kill("SIGKILL");
				await closed;
			}
		})());
	try {
		await bounded(
			new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					child.off("message", ready);
					child.off("error", failed);
					child.off("close", failed);
				};
				const failed = () => {
					cleanup();
					reject(new Error("Agent Smith private pool failed to start"));
				};
				const ready = (message: unknown) => {
					if (
						message &&
						typeof message === "object" &&
						"type" in message &&
						message.type === "ready"
					) {
						cleanup();
						resolve();
					}
				};
				child.on("message", ready);
				child.once("error", failed);
				child.once("close", failed);
			}),
			30_000,
		);
		server.listen(options.port, "0.0.0.0");
		await once(server, "listening");
		if (exited)
			throw new Error("Agent Smith private pool exited during startup");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Agent Smith public listener did not bind");
		return { port: address.port, pool: child, stop, exited: closed };
	} catch (error) {
		await stop();
		throw error;
	}
}
