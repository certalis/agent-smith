import {
	accessSync,
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Config,
	readClientRouting,
	resolveConfigPath,
} from "@agent-smith/config";
import type { ProviderWire } from "@agent-smith/types";

const ROUTING_BEGIN = "# >>> agent-smith local routing >>>";
const ROUTING_END = "# <<< agent-smith local routing <<<";
const LOCAL_CLIENT_KEY = "agent-smith-local";
const CLAUDE_COMPANION_DIRNAME = "agent-smith-claude-companion";
const CLAUDE_COMPANION_FILES = [
	".claude-plugin/plugin.json",
	"hooks/hooks.json",
	"hooks/provider-choice.js",
	"hooks/register.js",
] as const;

export const ROUTING_MARKER = ROUTING_BEGIN;
const CONFIG_CLIENT_MARKER = "# agent-smith config-driven client";

export interface InstallClientWrappersOptions {
	binDir: string;
	clientConfigPath?: string;
	claudePath?: string;
	codexPath?: string;
	port: number;
	baseUrl?: string;
	proxyKeyFile?: string;
	keepClaudeLogin?: boolean;
	providerPoolWires?: readonly ProviderWire[];
}

export interface LocalRoutingPaths {
	binDir: string;
	shellProfile: string;
	statePath: string;
}

export interface EnableLocalClientRoutingOptions
	extends Partial<LocalRoutingPaths> {
	clientConfigPath?: string;
	port: number;
	claudePath?: string;
	codexPath?: string;
	path?: string;
	baseUrl?: string;
	proxyKeyFile?: string;
	keepClaudeLogin?: boolean;
	providerPoolWires?: readonly ProviderWire[];
}

export interface LocalRoutingStatus {
	enabled: boolean;
	binDir: string;
	shellProfile: string;
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellDoubleQuote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function proxyBaseUrl(
	port: number,
	configuredBaseUrl: string | undefined,
	directProvider: string,
	wire: ProviderWire,
	providerPoolWires: readonly ProviderWire[] | undefined,
): string {
	const route = providerPoolWires?.includes(wire)
		? `/v1/pool/${wire}`
		: `/v1/${directProvider}`;
	return `${configuredBaseUrl ?? `http://127.0.0.1:${port}`}${route}`;
}

export function validateProxyKeyFile(proxyKeyFile: string): string {
	const resolvedPath = proxyKeyFile.startsWith("~/")
		? join(homedir(), proxyKeyFile.slice(2))
		: proxyKeyFile;
	let metadata: ReturnType<typeof statSync>;
	try {
		metadata = statSync(resolvedPath);
	} catch {
		throw new Error("Agent Smith forwarding-key file is not readable");
	}
	if (!metadata.isFile()) {
		throw new Error("Agent Smith forwarding-key path must be a file");
	}
	if ((metadata.mode & 0o077) !== 0) {
		throw new Error("Agent Smith forwarding-key file must be owner-only");
	}
	const key = readFileSync(resolvedPath, "utf8").trim();
	if (!/^[\x21-\x7e]{1,512}$/.test(key)) {
		throw new Error("Agent Smith forwarding-key file is invalid");
	}
	return resolvedPath;
}

function proxyKeySetup(proxyKeyFile: string | undefined): string {
	if (!proxyKeyFile) {
		return `export AGENT_SMITH_PROXY_KEY=${shellQuote(LOCAL_CLIENT_KEY)}`;
	}

	return `if [ ! -r ${shellQuote(proxyKeyFile)} ]; then
  echo "Agent Smith forwarding-key file is not readable" >&2
  exit 1
fi
export AGENT_SMITH_PROXY_KEY=$(cat ${shellQuote(proxyKeyFile)})`;
}

function claudeProxyCredential(keepClaudeLogin: boolean): string {
	if (!keepClaudeLogin) {
		return `export ANTHROPIC_API_KEY="$AGENT_SMITH_PROXY_KEY"`;
	}
	// An API key switches off Claude Code's login-only features (Chrome, claude.ai connectors); the proxy reads x-api-key either way.
	return `unset ANTHROPIC_API_KEY
export ANTHROPIC_CUSTOM_HEADERS="\${ANTHROPIC_CUSTOM_HEADERS:+$ANTHROPIC_CUSTOM_HEADERS
}x-api-key: $AGENT_SMITH_PROXY_KEY"`;
}

function claudeCompanionSourceDir(): string {
	const bundled = join(import.meta.dir, "claude-companion");
	if (existsSync(join(bundled, ".claude-plugin", "plugin.json"))) {
		return bundled;
	}

	const source = join(import.meta.dir, "..", "claude-companion");
	if (existsSync(join(source, ".claude-plugin", "plugin.json"))) {
		return source;
	}

	throw new Error("Agent-smith Claude companion files are missing");
}

function installClaudeCompanion(binDir: string): string {
	const sourceDir = claudeCompanionSourceDir();
	const targetDir = join(binDir, CLAUDE_COMPANION_DIRNAME);
	rmSync(targetDir, { force: true, recursive: true });
	for (const relativePath of CLAUDE_COMPANION_FILES) {
		const target = join(targetDir, relativePath);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		copyFileSync(
			join(sourceDir, relativePath),
			target,
			constants.COPYFILE_FICLONE,
		);
		chmodSync(target, 0o600);
	}
	for (const directory of [
		targetDir,
		join(targetDir, ".claude-plugin"),
		join(targetDir, "hooks"),
	]) {
		chmodSync(directory, 0o700);
	}
	return targetDir;
}

function claudeWrapper(
	claudePath: string,
	baseUrl: string,
	proxyKeyFile: string | undefined,
	keepClaudeLogin: boolean,
	companionDir: string,
): string {
	return `#!/bin/sh
# Generated by agent-smith. This file delegates to the real Claude Code binary.
unset AGENT_SMITH_ADMIN_KEY
unset AGENT_SMITH_PROXY_KEY
unset ANTHROPIC_AUTH_TOKEN
${proxyKeySetup(proxyKeyFile)}
${claudeProxyCredential(keepClaudeLogin)}
unset AGENT_SMITH_PROXY_KEY
export ANTHROPIC_BASE_URL=${shellQuote(baseUrl)}
exec ${shellQuote(claudePath)} --plugin-dir ${shellQuote(companionDir)} "$@"
`;
}

function codexWrapper(
	codexPath: string,
	baseUrl: string,
	proxyKeyFile: string | undefined,
): string {
	const config = [
		'model_provider="agent_smith"',
		'model_providers.agent_smith.name="Agent Smith"',
		`model_providers.agent_smith.base_url="${baseUrl}"`,
		'model_providers.agent_smith.env_key="AGENT_SMITH_PROXY_KEY"',
		'model_providers.agent_smith.wire_api="responses"',
		"model_providers.agent_smith.requires_openai_auth=false",
		"model_providers.agent_smith.supports_websockets=false",
	];
	const overrides = config
		.map((entry) => `  -c ${shellQuote(entry)}`)
		.join(" \\\n");

	return `#!/bin/sh
# Generated by agent-smith. This file delegates to the real Codex binary.
unset AGENT_SMITH_ADMIN_KEY
unset AGENT_SMITH_PROXY_KEY
${proxyKeySetup(proxyKeyFile)}
exec ${shellQuote(codexPath)} \\
${overrides} \\
  "$@"
`;
}

export async function installClientWrappers(
	options: InstallClientWrappersOptions,
): Promise<void> {
	if (options.clientConfigPath) {
		const launcher = fileURLToPath(
			new URL(
				import.meta.url.endsWith(".ts")
					? "./client-launcher.ts"
					: "./client-launcher.js",
				import.meta.url,
			),
		);
		mkdirSync(options.binDir, { recursive: true, mode: 0o700 });
		for (const [tool, target] of [
			["claude", options.claudePath],
			["codex", options.codexPath],
		] as const) {
			if (!target) continue;
			if (target === join(options.binDir, tool))
				throw new Error("A client launcher cannot call itself");
			const wrapper = join(options.binDir, tool);
			const companionDir =
				tool === "claude" ? installClaudeCompanion(options.binDir) : "";
			writeFileSync(
				wrapper,
				`#!/bin/sh\n${CONFIG_CLIENT_MARKER}\nexec ${[process.execPath, launcher, options.clientConfigPath, tool, target, companionDir].map(shellQuote).join(" ")} "$@"\n`,
				{ encoding: "utf8", mode: 0o700 },
			);
			chmodSync(wrapper, 0o700);
		}
		return;
	}
	if (options.baseUrl && !options.proxyKeyFile) {
		throw new Error(
			"A configured Agent Smith server requires a forwarding key file",
		);
	}
	mkdirSync(options.binDir, { recursive: true, mode: 0o700 });
	const proxyKeyFile = options.proxyKeyFile
		? validateProxyKeyFile(options.proxyKeyFile)
		: undefined;

	if (options.claudePath) {
		const claude = join(options.binDir, "claude");
		const companionDir = installClaudeCompanion(options.binDir);
		writeFileSync(
			claude,
			claudeWrapper(
				options.claudePath,
				proxyBaseUrl(
					options.port,
					options.baseUrl,
					"claude-code",
					"anthropic-messages",
					options.providerPoolWires,
				),
				proxyKeyFile,
				options.keepClaudeLogin === true,
				companionDir,
			),
			{
				encoding: "utf8",
				mode: 0o700,
			},
		);
		chmodSync(claude, 0o700);
	}
	if (options.codexPath) {
		const codex = join(options.binDir, "codex");
		writeFileSync(
			codex,
			codexWrapper(
				options.codexPath,
				proxyBaseUrl(
					options.port,
					options.baseUrl,
					"codex",
					"openai-responses",
					options.providerPoolWires,
				),
				proxyKeyFile,
			),
			{
				encoding: "utf8",
				mode: 0o700,
			},
		);
		chmodSync(codex, 0o700);
	}
}

function defaultShellProfile(): string {
	const shell = process.env.SHELL?.split("/").pop();
	return join(homedir(), shell === "bash" ? ".bashrc" : ".zshrc");
}

export function getLocalRoutingPaths(): LocalRoutingPaths {
	const configDir = dirname(resolveConfigPath());
	return {
		binDir: join(configDir, "client-bin"),
		shellProfile: defaultShellProfile(),
		statePath: join(configDir, "client-routing.json"),
	};
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function findClientExecutable(
	name: "claude" | "codex",
	binDir: string,
	path: string,
): string {
	for (const directory of path.split(":")) {
		if (!directory || directory === binDir) continue;
		const candidate = join(directory, name);
		if (isExecutable(candidate)) return candidate;
	}

	throw new Error(`${name} was not found in PATH`);
}

function readSavedClientPaths(
	statePath: string,
): Pick<InstallClientWrappersOptions, "claudePath" | "codexPath"> | null {
	if (!existsSync(statePath)) return null;

	try {
		const saved: unknown = JSON.parse(readFileSync(statePath, "utf8"));
		if (typeof saved === "object" && saved !== null) {
			const { claudePath, codexPath } = saved as {
				claudePath?: unknown;
				codexPath?: unknown;
			};
			const validClaude =
				typeof claudePath === "string" && isExecutable(claudePath)
					? claudePath
					: undefined;
			const validCodex =
				typeof codexPath === "string" && isExecutable(codexPath)
					? codexPath
					: undefined;
			if (validClaude || validCodex) {
				return { claudePath: validClaude, codexPath: validCodex };
			}
		}
	} catch {
		// Discover the real clients again below. A routing-state file is only a convenience.
	}

	return null;
}

function installedRoutingStatus(
	paths: Partial<LocalRoutingPaths> = {},
): LocalRoutingStatus {
	const defaults = getLocalRoutingPaths();
	const binDir = paths.binDir ?? defaults.binDir;
	const shellProfile = paths.shellProfile ?? defaults.shellProfile;
	let shellProfileHasRouting = false;
	try {
		shellProfileHasRouting =
			existsSync(shellProfile) &&
			readFileSync(shellProfile, "utf8").includes(ROUTING_BEGIN);
	} catch {
		// A status refresh must not prevent the local pool from being visible.
	}

	return {
		enabled:
			shellProfileHasRouting &&
			(existsSync(join(binDir, "claude")) || existsSync(join(binDir, "codex"))),
		binDir,
		shellProfile,
	};
}

export function getLocalRoutingStatus(
	paths: Partial<LocalRoutingPaths> = {},
): LocalRoutingStatus {
	const status = installedRoutingStatus(paths);
	if (!configClientWrappersInstalled(paths)) return status;
	try {
		return { ...status, enabled: readClientRouting().enabled };
	} catch {
		return { ...status, enabled: false };
	}
}

export function configClientWrappersInstalled(
	paths: Partial<LocalRoutingPaths> = {},
): boolean {
	const binDir = paths.binDir ?? getLocalRoutingPaths().binDir;
	const files = ["claude", "codex"]
		.map((name) => join(binDir, name))
		.filter(existsSync);
	return (
		installedRoutingStatus(paths).enabled &&
		files.length > 0 &&
		files.every((path) =>
			readFileSync(path, "utf8").includes(CONFIG_CLIENT_MARKER),
		)
	);
}

export async function launchConfiguredClient(
	configPath: string,
	tool: string,
	target: string,
	claudeCompanionDir: string,
	args: string[],
): Promise<number> {
	if (tool !== "claude" && tool !== "codex")
		throw new Error("Unknown Agent Smith client");
	const client = readClientRouting(configPath);
	const env = { ...process.env };
	delete env.AGENT_SMITH_ADMIN_KEY;
	delete env.AGENT_SMITH_PROXY_KEY;
	let command = [target, ...args];
	if (client.enabled) {
		if (!client.baseUrl || !client.proxyKeyFile)
			throw new Error("client.base_url and client.proxy_key_file are required");
		const keyFile = validateProxyKeyFile(client.proxyKeyFile);
		const wires = Object.keys(
			new Config(configPath).getProviderPools(),
		) as ProviderWire[];
		const base = proxyBaseUrl(
			8080,
			client.baseUrl,
			tool === "claude" ? "claude-code" : "codex",
			tool === "claude" ? "anthropic-messages" : "openai-responses",
			wires,
		);
		const script =
			tool === "claude"
				? claudeWrapper(
					target,
					base,
					keyFile,
					client.keepClaudeLogin === true,
					claudeCompanionDir,
				)
				: codexWrapper(target, base, keyFile);
		command = ["/bin/sh", "-c", script, "--", ...args];
	}
	const child = Bun.spawn(command, {
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const forward = {
		SIGINT: () => child.kill("SIGINT"),
		SIGTERM: () => child.kill("SIGTERM"),
		SIGHUP: () => child.kill("SIGHUP"),
	};
	for (const [signal, listener] of Object.entries(forward))
		process.on(signal, listener);
	try {
		return await child.exited;
	} finally {
		for (const [signal, listener] of Object.entries(forward))
			process.off(signal, listener);
	}
}

export async function enableLocalClientRouting(
	options: EnableLocalClientRoutingOptions,
): Promise<LocalRoutingStatus> {
	const defaults = getLocalRoutingPaths();
	const binDir = options.binDir ?? defaults.binDir;
	const shellProfile = options.shellProfile ?? defaults.shellProfile;
	const statePath = options.statePath ?? defaults.statePath;
	const saved = readSavedClientPaths(statePath);
	const path = options.path ?? process.env.PATH ?? "";
	const discoverClient = (name: "claude" | "codex"): string | undefined => {
		try {
			return findClientExecutable(name, binDir, path);
		} catch {
			return undefined;
		}
	};
	const claudePath =
		options.claudePath ?? saved?.claudePath ?? discoverClient("claude");
	const codexPath =
		options.codexPath ?? saved?.codexPath ?? discoverClient("codex");
	if (!claudePath && !codexPath) {
		throw new Error("Neither Claude Code nor Codex was found in PATH");
	}

	await installClientWrappers({
		binDir,
		claudePath,
		codexPath,
		port: options.port,
		baseUrl: options.baseUrl,
		proxyKeyFile: options.proxyKeyFile,
		keepClaudeLogin: options.keepClaudeLogin,
		clientConfigPath: options.clientConfigPath,
		providerPoolWires:
			options.providerPoolWires ??
			(options.clientConfigPath
				? []
				: (Object.keys(new Config().getProviderPools()) as ProviderWire[])),
	});

	const existingProfile = existsSync(shellProfile)
		? readFileSync(shellProfile, "utf8")
		: "";
	writeFileSync(
		shellProfile,
		updateShellProfileForRouting(existingProfile, binDir),
		{ encoding: "utf8", mode: 0o600 },
	);
	mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
	writeFileSync(statePath, JSON.stringify({ claudePath, codexPath }), {
		encoding: "utf8",
		mode: 0o600,
	});
	chmodSync(statePath, 0o600);

	return getLocalRoutingStatus({ binDir, shellProfile, statePath });
}

export function disableLocalClientRouting(
	paths: Partial<LocalRoutingPaths> = {},
): LocalRoutingStatus {
	const defaults = getLocalRoutingPaths();
	const binDir = paths.binDir ?? defaults.binDir;
	const shellProfile = paths.shellProfile ?? defaults.shellProfile;
	const statePath = paths.statePath ?? defaults.statePath;

	if (existsSync(shellProfile)) {
		writeFileSync(
			shellProfile,
			removeRoutingFromShellProfile(readFileSync(shellProfile, "utf8")),
			{ encoding: "utf8", mode: 0o600 },
		);
	}
	for (const name of ["claude", "codex"] as const) {
		const wrapper = join(binDir, name);
		if (existsSync(wrapper)) unlinkSync(wrapper);
	}
	rmSync(join(binDir, CLAUDE_COMPANION_DIRNAME), {
		force: true,
		recursive: true,
	});
	if (existsSync(statePath)) unlinkSync(statePath);

	return getLocalRoutingStatus({ binDir, shellProfile, statePath });
}

export function removeRoutingFromShellProfile(profile: string): string {
	const start = profile.indexOf(ROUTING_BEGIN);
	if (start === -1) return profile;

	const end = profile.indexOf(ROUTING_END, start);
	if (end === -1) return profile;

	const afterEnd = end + ROUTING_END.length;
	const newlineLength = profile.slice(afterEnd, afterEnd + 1) === "\n" ? 1 : 0;
	return `${profile.slice(0, start)}${profile.slice(afterEnd + newlineLength)}`;
}

export function updateShellProfileForRouting(
	profile: string,
	binDir: string,
): string {
	const withoutExistingBlock = removeRoutingFromShellProfile(profile);
	const separator =
		withoutExistingBlock.length === 0 || withoutExistingBlock.endsWith("\n")
			? ""
			: "\n";
	return `${withoutExistingBlock}${separator}${ROUTING_BEGIN}\nexport PATH=${shellDoubleQuote(`${binDir}:$PATH`)}\n${ROUTING_END}\n`;
}
