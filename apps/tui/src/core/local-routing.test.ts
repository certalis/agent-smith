import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	disableLocalClientRouting,
	enableLocalClientRouting,
	getLocalRoutingStatus,
	installClientWrappers,
	ROUTING_MARKER,
	removeRoutingFromShellProfile,
	updateShellProfileForRouting,
} from "./local-routing";

const tempDirs: string[] = [];

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-routing-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { force: true, recursive: true });
	}
});

describe("local client routing", () => {
	it("applies the install-client opt-in and removes it without changing real clients or unrelated shell settings", async () => {
		const directory = tempDir();
		const realBin = join(directory, "real-bin");
		const binDir = join(directory, "client-bin");
		const shellProfile = join(directory, ".zshrc");
		const configPath = join(directory, "ccflare.json");
		const proxyKeyFile = join(directory, "device.key");
		const originalProfile = "export EDITOR=vim\n# Keep my shell settings\n";
		const realClient = '#!/bin/sh\nprintf "%s" "$ANTHROPIC_BASE_URL"\n';
		mkdirSync(realBin);
		for (const name of ["claude", "codex"]) {
			writeFileSync(join(realBin, name), realClient, { mode: 0o700 });
		}
		writeFileSync(shellProfile, originalProfile);
		writeFileSync(proxyKeyFile, "synthetic-device-key\n", { mode: 0o600 });
		// A whitelist keeps proxy settings, real credentials and profile paths out.
		const environment = {
			HOME: directory,
			XDG_CONFIG_HOME: directory,
			SHELL: "/bin/zsh",
			PATH: `${realBin}:/usr/bin:/bin`,
			ccflare_CONFIG_PATH: configPath,
			ccflare_DB_PATH: join(directory, "pool.db"),
		};
		const apply = async (client?: Record<string, unknown>) => {
			writeFileSync(configPath, JSON.stringify({ client }), { mode: 0o600 });
			const child = Bun.spawn(
				[
					process.execPath,
					new URL("../main.ts", import.meta.url).pathname,
					"install-client",
				],
				{ env: environment, stdout: "pipe", stderr: "pipe" },
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({
				exitCode,
				error: exitCode === 0 ? "" : stdout + stderr,
			}).toEqual({ exitCode: 0, error: "" });
		};
		const target = {
			base_url: "https://pool.example.com",
			proxy_key_file: proxyKeyFile,
		};
		for (const client of [undefined, target]) {
			await apply(client);
			expect(existsSync(join(binDir, "claude"))).toBe(false);
			expect(readFileSync(shellProfile, "utf8")).toBe(originalProfile);
		}
		await apply({ ...target, enabled: true });
		expect(existsSync(join(binDir, "codex"))).toBe(true);
		expect(readFileSync(shellProfile, "utf8")).toContain(ROUTING_MARKER);
		const routed = Bun.spawnSync([join(binDir, "claude")], {
			env: environment,
		});
		expect(routed.exitCode).toBe(0);
		expect(routed.stdout.toString()).toBe(
			"https://pool.example.com/v1/claude-code",
		);
		await apply({ ...target, enabled: false });
		for (const name of ["claude", "codex"]) {
			expect(existsSync(join(binDir, name))).toBe(false);
			expect(readFileSync(join(realBin, name), "utf8")).toBe(realClient);
		}
		expect(existsSync(join(directory, "client-routing.json"))).toBe(false);
		expect(readFileSync(shellProfile, "utf8")).toBe(originalProfile);
	});

	it("routes Claude Code through the local Claude Code endpoint without touching the real client", async () => {
		const directory = tempDir();
		const realClaude = join(directory, "real-claude");
		writeFileSync(
			realClaude,
			'#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$ANTHROPIC_BASE_URL" "$ANTHROPIC_API_KEY" "$ANTHROPIC_AUTH_TOKEN" "$*"\n',
			{ mode: 0o700 },
		);

		await installClientWrappers({
			binDir: join(directory, "bin"),
			claudePath: realClaude,
			codexPath: join(directory, "real-codex"),
			port: 8123,
		});

		const result = Bun.spawnSync([join(directory, "bin", "claude"), "hello"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe(
			"http://127.0.0.1:8123/v1/claude-code|agent-smith-local|agent-smith-local|hello\n",
		);
	});

	it("routes both clients through a configured Agent-smith server and forwarding key", async () => {
		const directory = tempDir();
		const realClaude = join(directory, "real-claude");
		const realCodex = join(directory, "real-codex");
		const proxyKeyFile = join(directory, "agent-smith.key");
		writeFileSync(proxyKeyFile, "client-forwarding-key\n", { mode: 0o600 });
		writeFileSync(
			realClaude,
			'#!/bin/sh\nprintf "%s|%s\n" "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN"\n',
			{ mode: 0o700 },
		);
		writeFileSync(
			realCodex,
			'#!/bin/sh\nprintf "%s|%s\n" "$AGENT_SMITH_PROXY_KEY" "$*"\n',
			{ mode: 0o700 },
		);

		await installClientWrappers({
			binDir: join(directory, "bin"),
			claudePath: realClaude,
			codexPath: realCodex,
			port: 8123,
			baseUrl: "http://127.0.0.1:18181",
			proxyKeyFile,
		});

		const claude = Bun.spawnSync([join(directory, "bin", "claude")]);
		const codex = Bun.spawnSync([join(directory, "bin", "codex"), "exec"]);
		expect(claude.stdout.toString()).toBe(
			"http://127.0.0.1:18181/v1/claude-code|client-forwarding-key\n",
		);
		expect(codex.stdout.toString()).toContain("client-forwarding-key|");
		expect(codex.stdout.toString()).toContain(" exec\n");
		expect(codex.stdout.toString()).toContain(
			'model_providers.agent_smith.base_url="http://127.0.0.1:18181/v1/codex"',
		);
		expect(
			readFileSync(join(directory, "bin", "claude"), "utf8"),
		).not.toContain("client-forwarding-key");
	});

	it("gives Codex its own local Responses endpoint and preserves the user's arguments", async () => {
		const directory = tempDir();
		const realCodex = join(directory, "real-codex");
		writeFileSync(realCodex, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
			mode: 0o700,
		});

		await installClientWrappers({
			binDir: join(directory, "bin"),
			claudePath: join(directory, "real-claude"),
			codexPath: realCodex,
			port: 8123,
		});

		const result = Bun.spawnSync([
			join(directory, "bin", "codex"),
			"exec",
			"write tests",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain(
			'model_providers.agent_smith.base_url="http://127.0.0.1:8123/v1/codex"',
		);
		expect(result.stdout.toString()).toContain(
			'model_providers.agent_smith.wire_api="responses"',
		);
		expect(result.stdout.toString()).toContain("exec\nwrite tests\n");
	});

	it("routes both local clients through their configured protocol pools", async () => {
		const directory = tempDir();
		const realClaude = join(directory, "real-claude");
		const realCodex = join(directory, "real-codex");
		writeFileSync(
			realClaude,
			'#!/bin/sh\nprintf "%s\\n" "$ANTHROPIC_BASE_URL"\n',
			{ mode: 0o700 },
		);
		writeFileSync(realCodex, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
			mode: 0o700,
		});

		await installClientWrappers({
			binDir: join(directory, "bin"),
			claudePath: realClaude,
			codexPath: realCodex,
			port: 8123,
			providerPoolWires: ["anthropic-messages", "openai-responses"],
		});

		const claude = Bun.spawnSync([join(directory, "bin", "claude")]);
		const codex = Bun.spawnSync([join(directory, "bin", "codex"), "exec"]);
		expect(claude.stdout.toString()).toBe(
			"http://127.0.0.1:8123/v1/pool/anthropic-messages\n",
		);
		expect(codex.stdout.toString()).toContain(
			'model_providers.agent_smith.base_url="http://127.0.0.1:8123/v1/pool/openai-responses"',
		);
	});

	it("adds and removes only its marked shell PATH block", () => {
		const profile = "export EDITOR=vim\n";
		const updated = updateShellProfileForRouting(
			profile,
			"/tmp/agent-smith-bin",
		);

		expect(updated).toContain('export PATH="/tmp/agent-smith-bin:$PATH"');
		expect(updateShellProfileForRouting(updated, "/tmp/agent-smith-bin")).toBe(
			updated,
		);
		expect(removeRoutingFromShellProfile(updated)).toBe(profile);
	});

	it("enables and removes routing without changing the real client binaries", async () => {
		const directory = tempDir();
		const binDir = join(directory, "bin");
		const shellProfile = join(directory, ".zshrc");
		const statePath = join(directory, "routing.json");
		const realClaude = join(directory, "real-claude");
		const realCodex = join(directory, "real-codex");
		writeFileSync(realClaude, "#!/bin/sh\n", { mode: 0o700 });
		writeFileSync(realCodex, "#!/bin/sh\n", { mode: 0o700 });
		writeFileSync(shellProfile, "export EDITOR=vim\n");

		await enableLocalClientRouting({
			binDir,
			shellProfile,
			statePath,
			claudePath: realClaude,
			codexPath: realCodex,
			port: 8123,
			providerPoolWires: [],
		});

		expect(existsSync(realClaude)).toBe(true);
		expect(existsSync(realCodex)).toBe(true);
		expect(readFileSync(shellProfile, "utf8")).toContain(ROUTING_MARKER);
		expect(getLocalRoutingStatus({ binDir, shellProfile }).enabled).toBe(true);

		disableLocalClientRouting({ binDir, shellProfile, statePath });
		expect(readFileSync(shellProfile, "utf8")).toBe("export EDITOR=vim\n");
		expect(getLocalRoutingStatus({ binDir, shellProfile }).enabled).toBe(false);
		expect(existsSync(realClaude)).toBe(true);
		expect(existsSync(realCodex)).toBe(true);
	});

	it("enables the installed client when the other client is absent", async () => {
		const directory = tempDir();
		const binDir = join(directory, "bin");
		const shellProfile = join(directory, ".zshrc");
		const realClaude = join(directory, "claude");
		writeFileSync(realClaude, "#!/bin/sh\n", { mode: 0o700 });

		const status = await enableLocalClientRouting({
			binDir,
			shellProfile,
			statePath: join(directory, "routing.json"),
			claudePath: realClaude,
			path: directory,
			port: 8123,
			providerPoolWires: [],
		});

		expect(status.enabled).toBe(true);
		expect(existsSync(join(binDir, "claude"))).toBe(true);
		expect(existsSync(join(binDir, "codex"))).toBe(false);
	});

	it("refuses a configured Agent-smith server without a forwarding key file", async () => {
		const directory = tempDir();
		const realClaude = join(directory, "claude");
		writeFileSync(realClaude, "#!/bin/sh\n", { mode: 0o700 });

		await expect(
			enableLocalClientRouting({
				binDir: join(directory, "bin"),
				shellProfile: join(directory, ".zshrc"),
				statePath: join(directory, "routing.json"),
				claudePath: realClaude,
				path: directory,
				port: 8123,
				baseUrl: "http://127.0.0.1:18181",
				providerPoolWires: [],
			}),
		).rejects.toThrow("requires a forwarding key file");
	});

	it("explains when the configured forwarding-key file is missing", async () => {
		const directory = tempDir();
		const realClaude = join(directory, "claude");
		writeFileSync(realClaude, "#!/bin/sh\n", { mode: 0o700 });

		await expect(
			installClientWrappers({
				binDir: join(directory, "bin"),
				claudePath: realClaude,
				port: 8123,
				baseUrl: "http://127.0.0.1:18181",
				proxyKeyFile: join(directory, "missing.key"),
			}),
		).rejects.toThrow("forwarding-key file is not readable");
	});

	it("refuses a forwarding-key file readable by other users", async () => {
		const directory = tempDir();
		const realClaude = join(directory, "claude");
		const proxyKeyFile = join(directory, "agent-smith.key");
		writeFileSync(realClaude, "#!/bin/sh\n", { mode: 0o700 });
		writeFileSync(proxyKeyFile, "client-forwarding-key\n", { mode: 0o644 });

		await expect(
			installClientWrappers({
				binDir: join(directory, "bin"),
				claudePath: realClaude,
				port: 8123,
				baseUrl: "http://127.0.0.1:18181",
				proxyKeyFile,
			}),
		).rejects.toThrow("forwarding-key file must be owner-only");
	});
});
