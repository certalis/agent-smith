import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
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
		});

		expect(status.enabled).toBe(true);
		expect(existsSync(join(binDir, "claude"))).toBe(true);
		expect(existsSync(join(binDir, "codex"))).toBe(false);
	});
});
