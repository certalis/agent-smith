import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readClientRouting, resolveConfigPath } from "@agent-smith/config";
import { shellQuote } from "./local-routing";
import { clean, type MenubarSnapshot, renderMenubar } from "./menubar";
import type { PoolStatus } from "./pool-status";

const COMMANDS = ["install", "uninstall", "render"] as const;
const PLUGIN_FILE = "agent-smith-pool.5m.sh";
const PLUGIN_MARKER = "menubar render";
const SSH_OPTIONS = [
	"-o",
	"BatchMode=yes",
	"-o",
	"ConnectTimeout=15",
	"-o",
	"UpdateHostKeys=no",
	"-o",
	"LogLevel=ERROR",
];

export type MenubarDeps = {
	configPath: string;
	cachePath: string;
	runtime: string;
	entry: () => string;
	pluginDirectory: () => string | null;
	fetchStatus: (host: string) => Promise<PoolStatus>;
	now: () => number;
	log: (line: string) => void;
};

function swiftBarPluginDirectory(): string | null {
	if (process.platform !== "darwin") return null;
	const result = Bun.spawnSync([
		"defaults",
		"read",
		"com.ameba.SwiftBar",
		"PluginDirectory",
	]);
	const path = result.exitCode === 0 ? result.stdout.toString().trim() : "";
	if (!path) return null;
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function remoteScript(): Promise<string> {
	const built = new URL("./pool-status.js", import.meta.url);
	if (existsSync(built)) return readFileSync(built, "utf8");
	const output = await Bun.build({
		entrypoints: [fileURLToPath(new URL("../pool-status.ts", import.meta.url))],
		target: "bun",
	});
	const [artifact] = output.outputs;
	if (!output.success || !artifact)
		throw new Error("Pool status script could not be built");
	return artifact.text();
}

async function fetchPoolStatus(host: string): Promise<PoolStatus> {
	const result = Bun.spawnSync(
		["ssh", ...SSH_OPTIONS, host, "bun", "run", "-"],
		{
			stdin: new Blob([await remoteScript()]),
			env: process.env,
			timeout: 45_000,
		},
	);
	if (result.exitedDueToTimeout) throw new Error("timed out");
	if (result.exitCode !== 0)
		throw new Error(
			clean(result.stderr.toString().split("\n")[0]) || "ssh failed",
		);
	return JSON.parse(result.stdout.toString()) as PoolStatus;
}

function defaultDeps(): MenubarDeps {
	return {
		configPath: resolveConfigPath(),
		cachePath: join(
			homedir(),
			"Library",
			"Caches",
			"agent-smith",
			"menubar-status.json",
		),
		runtime: Bun.which("bun") ?? process.execPath,
		entry: () => realpathSync(process.argv[1] ?? ""),
		pluginDirectory: swiftBarPluginDirectory,
		fetchStatus: fetchPoolStatus,
		now: Date.now,
		log: console.log,
	};
}

function readCache(path: string): MenubarSnapshot["cached"] {
	try {
		const cached = JSON.parse(readFileSync(path, "utf8"));
		return typeof cached?.fetchedAt === "number" &&
			Array.isArray(cached?.status?.accounts)
			? cached
			: null;
	} catch {
		return null;
	}
}

async function loadSnapshot(deps: MenubarDeps): Promise<MenubarSnapshot> {
	try {
		const host = readClientRouting(deps.configPath).poolSshHost;
		if (!host)
			throw new Error(`Set client.pool_ssh_host in ${deps.configPath}`);
		const cached = {
			fetchedAt: deps.now(),
			status: await deps.fetchStatus(host),
		};
		mkdirSync(dirname(deps.cachePath), { recursive: true, mode: 0o700 });
		writeFileSync(deps.cachePath, JSON.stringify(cached), { mode: 0o600 });
		return { cached, error: null };
	} catch (error) {
		return {
			cached: readCache(deps.cachePath),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function pluginScript(runtime: string, entry: string): string {
	return `#!/bin/sh
# <swiftbar.title>Agent Smith pool</swiftbar.title>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
export SSH_AUTH_SOCK="\${SSH_AUTH_SOCK:-$(/bin/launchctl getenv SSH_AUTH_SOCK)}"
exec ${shellQuote(runtime)} ${shellQuote(entry)} ${PLUGIN_MARKER}
`;
}

function install(deps: MenubarDeps): void {
	const directory = deps.pluginDirectory();
	if (!directory)
		throw new Error(
			"SwiftBar has no plugin folder. On macOS, install it (brew install --cask swiftbar), open it once and pick a plugin folder, then run this again.",
		);
	if (!readClientRouting(deps.configPath).poolSshHost)
		throw new Error(`Set client.pool_ssh_host in ${deps.configPath} first`);
	const path = join(directory, PLUGIN_FILE);
	writeFileSync(path, pluginScript(deps.runtime, deps.entry()));
	chmodSync(path, 0o755);
	deps.log(
		`Installed ${path}. SwiftBar shows the pool shortly and refreshes it every 5 minutes.`,
	);
}

function uninstall(deps: MenubarDeps): void {
	const directory = deps.pluginDirectory();
	const path = directory ? join(directory, PLUGIN_FILE) : null;
	if (
		!path ||
		!existsSync(path) ||
		!readFileSync(path, "utf8").includes(PLUGIN_MARKER)
	) {
		deps.log("No Agent Smith menu bar plugin is installed.");
		return;
	}
	rmSync(path);
	deps.log(`Removed ${path}.`);
}

export async function runMenubarCommand(
	argv: string[],
	overrides: Partial<MenubarDeps> = {},
): Promise<void> {
	const { positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
	});
	const [command] = positionals;
	if (
		positionals.length !== 1 ||
		!COMMANDS.some((candidate) => candidate === command)
	)
		throw new Error(`usage: agent-smith menubar ${COMMANDS.join("|")}`);
	const deps = { ...defaultDeps(), ...overrides };
	if (command === "install") return install(deps);
	if (command === "uninstall") return uninstall(deps);
	const snapshot = await loadSnapshot(deps);
	deps.log(renderMenubar(snapshot, deps.now()).join("\n"));
}
