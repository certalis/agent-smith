import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export type StandaloneOptions = {
	origin: string;
	port: number;
	poolPort: number;
	poolHost: string;
	dashboard: boolean;
	stateDir: string;
	socketPath: string;
	configPath: string;
	dbPath: string;
	clientKeysFile: string;
	adminKey: string;
	proxyKey: string;
};

function readKeysFile(path: string): { adminKey?: string; proxyKey?: string } {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = fstatSync(descriptor);
		if (
			!stat.isFile() ||
			stat.size > 4096 ||
			(stat.mode & 0o077) !== 0 ||
			(stat.uid !== 0 && stat.uid !== process.getuid?.())
		) {
			throw new Error("Unsafe keys file");
		}
		return JSON.parse(readFileSync(descriptor, "utf8"));
	} catch {
		throw new Error(
			"Agent Smith requires a readable owner-only private keys file",
		);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

export function readStandaloneOptions(
	env: NodeJS.ProcessEnv,
): StandaloneOptions {
	const origin = env.AGENT_SMITH_PUBLIC_ORIGIN ?? env.RENDER_EXTERNAL_URL;
	try {
		if (
			!origin ||
			new URL(origin).protocol !== "https:" ||
			new URL(origin).origin !== origin
		) {
			throw new Error("Invalid origin");
		}
	} catch {
		throw new Error("Agent Smith requires an exact HTTPS origin");
	}
	const port = Number(env.PORT ?? "10000");
	const poolPort = Number(env.AGENT_SMITH_POOL_PORT ?? "8081");
	if (
		[port, poolPort].some(
			(value) => !Number.isSafeInteger(value) || value < 1 || value > 65535,
		) ||
		port === poolPort
	) {
		throw new Error(
			"Agent Smith public and private ports must be valid and distinct",
		);
	}
	const stateDir = env.AGENT_SMITH_STATE_DIR ?? "/var/data/agent-smith/state";
	const paths = {
		stateDir,
		socketPath: join(stateDir, "control.sock"),
		configPath: env.AGENT_SMITH_CONFIG_PATH ?? join(stateDir, "config.json"),
		dbPath: env.AGENT_SMITH_DB_PATH ?? join(stateDir, "pool.db"),
		clientKeysFile:
			env.AGENT_SMITH_CLIENT_KEYS_FILE ?? join(stateDir, "clients.json"),
	};
	const keysPath =
		env.AGENT_SMITH_KEYS_FILE ?? join(dirname(stateDir), "keys.json");
	if ([...Object.values(paths), keysPath].some((path) => !isAbsolute(path))) {
		throw new Error("Agent Smith state and key paths must be absolute");
	}
	const keys =
		env.AGENT_SMITH_ADMIN_KEY || env.AGENT_SMITH_PROXY_KEY
			? {
					adminKey: env.AGENT_SMITH_ADMIN_KEY,
					proxyKey: env.AGENT_SMITH_PROXY_KEY,
				}
			: readKeysFile(keysPath);
	if (
		!keys ||
		typeof keys !== "object" ||
		![keys.adminKey, keys.proxyKey].every(
			(key) => typeof key === "string" && /^[\x21-\x7e]{32,512}$/.test(key),
		) ||
		keys.adminKey === keys.proxyKey
	) {
		throw new Error(
			"Agent Smith requires distinct administrator and proxy keys of at least 32 characters",
		);
	}
	return {
		origin,
		port,
		poolPort,
		poolHost: env.AGENT_SMITH_POOL_HOST ?? "127.0.0.1",
		dashboard: env.AGENT_SMITH_POOL_DASHBOARD === "1",
		...paths,
		adminKey: keys.adminKey as string,
		proxyKey: keys.proxyKey as string,
	};
}

export function poolEnvironment(
	options: StandaloneOptions,
	env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return {
		...env,
		PORT: String(options.poolPort),
		AGENT_SMITH_POOL_PORT: String(options.poolPort),
		AGENT_SMITH_HOST: options.poolHost,
		AGENT_SMITH_STATE_DIR: options.stateDir,
		AGENT_SMITH_POOL_DASHBOARD: options.dashboard ? "1" : "0",
		// The public entrance reaches the pool only through its Unix socket, so loopback TCP means an SSH session on the host.
		AGENT_SMITH_TRUST_LOOPBACK: options.dashboard ? "true" : "false",
		AGENT_SMITH_CONFIG_PATH: options.configPath,
		AGENT_SMITH_DB_PATH: options.dbPath,
		AGENT_SMITH_CLIENT_KEYS_FILE: options.clientKeysFile,
		AGENT_SMITH_ADMIN_KEY: options.adminKey,
		AGENT_SMITH_PROXY_KEY: options.proxyKey,
	};
}
