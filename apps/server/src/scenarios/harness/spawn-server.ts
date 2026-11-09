import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Duration, durationMs } from "./scenario";

const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const PROXY_VARIABLES = [
	"ALL_PROXY",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"NO_PROXY",
	"all_proxy",
	"https_proxy",
	"http_proxy",
	"no_proxy",
] as const;
let proxyEnvironmentQueue = Promise.resolve();
const proxyEnvironmentScope = new AsyncLocalStorage<boolean>();

export type ScenarioWorkspace = {
	configPath: string;
	dbPath: string;
	directory: string;
};

type SpawnServerOptions = {
	workspace?: ScenarioWorkspace;
	standalone?: boolean;
	privateSocket?: boolean;
	config?: Record<string, unknown>;
	environment?: Record<string, string>;
	initialTime?: number;
	seed?: (workspace: ScenarioWorkspace) => void;
};

type ReadyMessage = {
	pid: number;
	port: number;
	type: "ready";
};

type ChildMessage =
	| ReadyMessage
	| { error: string; id?: string; type: "error" }
	| { id: string; now: number; type: "advanced" }
	| { id: string; type: "stopped" }
	| { id: string; type: "pool-exited" }
	| { type: "fetch-guard"; url: string };

type ChildOutput = { stderr: string; stdout: string };

function withoutProxyVariables(
	environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const {
		ALL_PROXY: _allProxy,
		HTTPS_PROXY: _httpsProxy,
		HTTP_PROXY: _httpProxy,
		NO_PROXY: _noProxy,
		all_proxy: _lowerAllProxy,
		https_proxy: _lowerHttpsProxy,
		http_proxy: _lowerHttpProxy,
		no_proxy: _lowerNoProxy,
		...cleanEnvironment
	} = environment;

	return cleanEnvironment;
}

export async function withoutProxyEnvironment<T>(
	operation: () => Promise<T>,
): Promise<T> {
	if (proxyEnvironmentScope.getStore()) {
		return await operation();
	}

	const previous = proxyEnvironmentQueue;
	let release: () => void = () => {};
	proxyEnvironmentQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;

	const values = new Map(
		PROXY_VARIABLES.map((name) => [name, process.env[name]]),
	);
	for (const name of PROXY_VARIABLES) {
		delete process.env[name];
	}

	try {
		return await proxyEnvironmentScope.run(true, operation);
	} finally {
		for (const [name, value] of values) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		release();
	}
}

function waitFor<T>(
	promise: Promise<T>,
	timeoutMs: number,
	description: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`Timed out waiting for ${description}`)),
			timeoutMs,
		);
	});

	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeout) {
			clearTimeout(timeout);
		}
	});
}

async function waitForHealth(url: string, proxyKey?: string): Promise<void> {
	const deadline = performance.now() + START_TIMEOUT_MS;
	let lastError = "no response";

	while (performance.now() < deadline) {
		try {
			const response = await fetch(`${url}/health`, {
				headers: proxyKey ? { "x-api-key": proxyKey } : undefined,
			});
			if (response.ok) {
				return;
			}
			lastError = `status ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}

		await Bun.sleep(20);
	}

	throw new Error(`Server child did not become healthy: ${lastError}`);
}

function isRunning(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

async function waitForExit(
	child: ChildProcess,
	timeoutMs: number,
): Promise<boolean> {
	if (!isRunning(child)) {
		return true;
	}

	const exited = once(child, "exit").then(() => true);
	return await waitFor(exited, timeoutMs, "server child to exit").catch(
		() => false,
	);
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (!isRunning(child)) {
		return;
	}

	child.kill("SIGTERM");
	if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
		child.kill("SIGKILL");
		await waitForExit(child, STOP_TIMEOUT_MS);
	}
}

function captureOutput(child: ChildProcess): ChildOutput {
	const output: ChildOutput = { stderr: "", stdout: "" };
	child.stdout?.on("data", (chunk: Buffer) => {
		output.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output.stderr += chunk.toString("utf8");
	});
	return output;
}

function errorWithChildOutput(error: unknown, output?: ChildOutput): Error {
	const message = error instanceof Error ? error.message : String(error);
	const captured = [
		output?.stdout && `stdout:\n${output.stdout}`,
		output?.stderr && `stderr:\n${output.stderr}`,
	]
		.filter(Boolean)
		.join("\n");
	return new Error(
		captured ? `${message}\nServer child output:\n${captured}` : message,
	);
}

export class SpawnedServer {
	readonly guardedUrls: string[] = [];
	readonly pid: number;
	readonly url: string;
	readonly unixSocket: string | undefined;
	readonly workspace: string;

	private stopped = false;

	constructor(
		private readonly child: ChildProcess,
		private readonly paths: ScenarioWorkspace,
		ready: ReadyMessage,
		readonly output: ChildOutput,
		private readonly options: SpawnServerOptions,
	) {
		this.pid = ready.pid;
		this.url = `http://127.0.0.1:${ready.port}`;
		this.workspace = paths.directory;
		this.unixSocket = options.privateSocket
			? join(paths.directory, "control.sock")
			: undefined;

		child.on("message", (message: ChildMessage) => {
			if (message.type === "fetch-guard") {
				this.guardedUrls.push(message.url);
			}
		});
	}

	async advance(by: Duration): Promise<void> {
		const id = crypto.randomUUID();
		await this.sendAndWait({ byMs: durationMs(by), id, type: "advance" });
	}

	async terminatePool(): Promise<void> {
		if (!this.options.standalone)
			throw new Error("Pool termination requires a standalone scenario");
		await this.sendAndWait({ id: crypto.randomUUID(), type: "terminate-pool" });
	}

	/** Simulate an atomic-config-write failure using only this fixture's temporary path. */
	blockConfigWrite(): void {
		renameSync(this.paths.configPath, `${this.paths.configPath}.backup`);
		mkdirSync(this.paths.configPath);
	}

	restoreConfigWrite(): void {
		rmdirSync(this.paths.configPath);
		renameSync(`${this.paths.configPath}.backup`, this.paths.configPath);
	}

	async stop(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.stopped = true;

		try {
			await this.stopProcess();
		} finally {
			rmSync(this.paths.directory, { recursive: true, force: true });
		}
	}

	async restart(now: number): Promise<SpawnedServer> {
		await this.stopProcess();
		const next = await spawnServer({
			...this.options,
			workspace: this.paths,
			config: undefined,
			seed: undefined,
			initialTime: now,
		});
		next.guardedUrls.unshift(...this.guardedUrls);
		this.stopped = true;
		return next;
	}

	private async stopProcess(): Promise<void> {
		try {
			if (this.options.standalone && isRunning(this.child))
				await this.sendAndWait({ id: crypto.randomUUID(), type: "stop" });
		} finally {
			await stopChild(this.child);
		}
	}

	private async sendAndWait(message: {
		id: string;
		type: "advance" | "stop" | "terminate-pool";
		byMs?: number;
	}): Promise<void> {
		const reply = new Promise<void>((resolve, reject) => {
			const onMessage = (response: ChildMessage) => {
				if (!("id" in response) || response.id !== message.id) {
					return;
				}

				this.child.off("message", onMessage);
				if (response.type === "error") {
					reject(new Error(response.error));
					return;
				}

				resolve();
			};
			this.child.on("message", onMessage);
			this.child.send(message, (error) => {
				if (error) {
					this.child.off("message", onMessage);
					reject(error);
				}
			});
		});

		await waitFor(reply, START_TIMEOUT_MS, `server child ${message.type}`);
	}
}

export async function spawnServer(
	options: SpawnServerOptions = {},
): Promise<SpawnedServer> {
	const directory =
		options.workspace?.directory ??
		mkdtempSync(join(tmpdir(), "agent-smith-scenario-server-"));
	const paths: ScenarioWorkspace = {
		configPath: join(directory, "config.json"),
		dbPath: join(directory, "agent-smith.db"),
		directory,
	};
	let child: ChildProcess | undefined;
	let output: ChildOutput | undefined;

	try {
		if (options.config) {
			writeFileSync(paths.configPath, JSON.stringify(options.config), {
				encoding: "utf8",
				mode: 0o600,
			});
		}
		options.seed?.(paths);
		const poolEntry = fileURLToPath(
			new URL("./server-entry.ts", import.meta.url),
		);
		let entry = poolEntry;
		if (options.standalone) {
			const build = await Bun.build({
				entrypoints: [
					fileURLToPath(new URL("./standalone-entry.ts", import.meta.url)),
				],
				outdir: directory,
				naming: "standalone.mjs",
				target: "node",
			});
			if (!build.success)
				throw new Error(
					`Standalone scenario build failed: ${build.logs.join("\n")}`,
				);
			entry = join(directory, "standalone.mjs");
		}
		const spawnedChild = fork(entry, [], {
			execArgv: [],
			execPath: options.standalone ? "node" : process.execPath,
			env: {
				...withoutProxyVariables(process.env),
				AGENT_SMITH_ENROLLMENT_ORIGIN: undefined,
				AGENT_SMITH_SCENARIO_CLAUDE_OAUTH_URL: undefined,
				...options.environment,
				AGENT_SMITH_STATE_DIR: options.standalone ? directory : undefined,
				AGENT_SMITH_SCENARIO_POOL_ENTRY: options.standalone
					? poolEntry
					: undefined,
				AGENT_SMITH_SCENARIO_UNIX_SOCKET: options.privateSocket
					? join(directory, "control.sock")
					: undefined,
				AGENT_SMITH_SCENARIO_INITIAL_TIME: String(
					options.initialTime ?? Date.now(),
				),
				AGENT_SMITH_CONFIG_PATH: paths.configPath,
				AGENT_SMITH_DB_PATH: paths.dbPath,
			},
			silent: true,
		});
		child = spawnedChild;
		output = captureOutput(spawnedChild);

		const ready = await waitFor(
			new Promise<ReadyMessage>((resolve, reject) => {
				spawnedChild.on("message", (message: ChildMessage) => {
					if (message.type === "ready") {
						resolve(message);
					} else if (message.type === "error") {
						reject(new Error(message.error));
					}
				});
				spawnedChild.once("error", reject);
				spawnedChild.once("exit", (code, signal) => {
					reject(
						new Error(
							`Server child exited before ready (code ${code}, signal ${signal})`,
						),
					);
				});
			}),
			START_TIMEOUT_MS,
			"server child to report ready",
		);

		if (ready.pid !== spawnedChild.pid) {
			throw new Error(
				`Server child reported pid ${ready.pid}, expected ${spawnedChild.pid ?? "unknown"}`,
			);
		}

		const server = new SpawnedServer(
			spawnedChild,
			paths,
			ready,
			output,
			options,
		);
		await withoutProxyEnvironment(async () => {
			if (options.standalone) {
				const health = await fetch(`${server.url}/readyz`, {
					headers: { host: "pool.example" },
				});
				if (!health.ok)
					throw new Error(`Standalone readiness failed: ${health.status}`);
			} else
				await waitForHealth(
					server.url,
					options.environment?.AGENT_SMITH_PROXY_KEY ??
						process.env.AGENT_SMITH_PROXY_KEY,
				);
		});
		return server;
	} catch (error) {
		if (child) {
			await stopChild(child);
		}
		rmSync(directory, { recursive: true, force: true });
		throw errorWithChildOutput(error, output);
	}
}
