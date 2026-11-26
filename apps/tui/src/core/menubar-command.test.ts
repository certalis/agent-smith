import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MenubarDeps, runMenubarCommand } from "./menubar-command";
import type { PoolStatus } from "./pool-status";

const NOW = Date.UTC(2026, 0, 5, 12);
const HOST = "pool-admin@ssh.example.test";
const STATUS: PoolStatus = {
	routingEnabled: true,
	maxUsagePercent: 90,
	enrollmentUrl: "https://pool.example.test/pool-enroll",
	emails: [],
	accounts: [
		{
			name: "alice",
			paused: false,
			blocked: false,
			poolAllowed: true,
			tokenStatus: "valid",
			usage: {
				fiveHour: {
					utilization: 0.1,
					seenAt: NOW,
					resetAt: NOW + 1,
					status: null,
				},
				sevenDay: {
					utilization: 0.2,
					seenAt: NOW,
					resetAt: NOW + 1,
					status: null,
				},
				weeklyByModel: {},
			},
		},
	],
};

const directories: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
	process.env.PATH = originalPath;
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function fixture(client: Record<string, unknown> = { pool_ssh_host: HOST }) {
	const root = mkdtempSync(join(tmpdir(), "agent-smith-menubar's "));
	directories.push(root);
	const plugins = join(root, "plugins");
	mkdirSync(plugins);
	const cliBin = join(root, "cli-bin");
	mkdirSync(cliBin);
	const configPath = join(root, "agent-smith.json");
	writeFileSync(configPath, JSON.stringify({ client }), { mode: 0o600 });
	const output: string[] = [];
	const deps: Partial<MenubarDeps> = {
		configPath,
		cachePath: join(root, "cache", "menubar-status.json"),
		binDirectories: () => [cliBin],
		pluginDirectory: () => plugins,
		now: () => NOW,
		log: (line) => output.push(line),
	};
	const run = (command: string, extra: Partial<MenubarDeps> = {}) =>
		runMenubarCommand([command], { ...deps, ...extra });
	return {
		root,
		cliBin,
		plugin: join(plugins, "agent-smith-pool.5m.sh"),
		output,
		run,
	};
}

describe("menubar install", () => {
	it("writes a SwiftBar plugin that finds the CLI each time it runs, so a reinstall keeps it working", async () => {
		const f = fixture();
		await f.run("install");
		writeFileSync(join(f.cliBin, "agent-smith"), `#!/bin/sh\necho "$@"\n`, {
			mode: 0o755,
		});

		const plugin = Bun.spawnSync(["/bin/sh", f.plugin], {
			env: { PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: "/tmp/agent.sock" },
		});
		expect(plugin.stdout.toString()).toBe("menubar render\n");
		expect(statSync(f.plugin).mode & 0o777).toBe(0o755);
	});

	it("refuses before writing anything when the pool host or SwiftBar is missing", async () => {
		const f = fixture({});
		await expect(f.run("install")).rejects.toThrow("client.pool_ssh_host");
		await expect(
			f.run("install", { pluginDirectory: () => null }),
		).rejects.toThrow("SwiftBar");
		expect(existsSync(f.plugin)).toBe(false);
	});

	it("removes only its own plugin", async () => {
		const f = fixture();
		writeFileSync(f.plugin, "#!/bin/sh\necho someone else's plugin\n");
		await f.run("uninstall");
		expect(existsSync(f.plugin)).toBe(true);

		await f.run("install");
		await f.run("uninstall");
		expect(existsSync(f.plugin)).toBe(false);
	});
});

describe("menubar render", () => {
	it("caches a fresh status and falls back to it when the next refresh fails", async () => {
		const f = fixture();
		await f.run("render", { fetchStatus: async () => STATUS });
		const cache = join(f.root, "cache", "menubar-status.json");
		expect(statSync(cache).mode & 0o777).toBe(0o600);
		expect(f.output[0]).toStartWith("1/1 |");

		await f.run("render", {
			fetchStatus: async () => {
				throw new Error("timed out");
			},
		});
		expect(f.output[1]).toStartWith("1/1 ⚠ |");
		expect(f.output[1]).toContain("Last refresh failed (timed out)");
	});

	it("tells the user which setting is missing", async () => {
		const f = fixture({});
		await f.run("render");
		expect(f.output[0]).toContain("Pool status unavailable");
		expect(f.output[0]).toContain("client.pool_ssh_host");
	});

	it("sends the bundled status script to the configured host over ssh", async () => {
		const f = fixture();
		const bin = join(f.root, "bin");
		mkdirSync(bin);
		writeFileSync(join(f.root, "ssh-stdout"), JSON.stringify(STATUS));
		writeFileSync(
			join(bin, "ssh"),
			`#!/bin/sh
root=$(dirname "$(dirname "$0")")
printf '%s\\n' "$@" > "$root/ssh-args"
cat > "$root/ssh-stdin"
cat "$root/ssh-stdout"
`,
			{ mode: 0o755 },
		);
		process.env.PATH = `${bin}:${originalPath}`;
		await f.run("render");

		expect(readFileSync(join(f.root, "ssh-args"), "utf8")).toEndWith(
			`${HOST}\nbun\nrun\n-\n`,
		);
		expect(readFileSync(join(f.root, "ssh-stdin"), "utf8")).toContain(
			"enrollment-emails",
		);
		expect(f.output[0]).toStartWith("1/1 |");
	});
});
