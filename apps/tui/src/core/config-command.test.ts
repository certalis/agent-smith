import { afterEach, expect, test } from "bun:test";
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

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function fixture(config: object) {
	const root = mkdtempSync(join(tmpdir(), "agent-smith-config-command-"));
	directories.push(root);
	const path = join(root, "config.json");
	const original = JSON.stringify(config);
	writeFileSync(path, original);
	const run = (...args: string[]) =>
		Bun.spawnSync(
			[
				process.execPath,
				"--no-env-file",
				process.env.AGENT_SMITH_TEST_CLI_ENTRY ??
					new URL("../main.ts", import.meta.url).pathname,
				...args,
			],
			{
				env: {
					HOME: root,
					XDG_CONFIG_HOME: root,
					PATH: "/usr/bin:/bin",
					AGENT_SMITH_CONFIG_PATH: path,
					AGENT_SMITH_DB_PATH: join(root, "pool.db"),
				},
			},
		);
	return { root, path, original, run };
}

test("rewrites a laptop config in place, preserving a private backup and allowing a safe retry", () => {
	const f = fixture({
		lb_strategy: "session",
		client_id: "synthetic",
		client: { enabled: false },
		providers: { anthropic: { enabled: true } },
		provider_pools: { "anthropic-messages": ["anthropic"] },
		max_body_bytes: 1234,
		request_scoped_429_retry_delay_ms: 9,
		quota_threshold: 0.9,
		retry_attempts: 3,
		retry_delay_ms: 12,
		retry_backoff: 2,
		session_duration_ms: 30,
	});
	const result = f.run("config", "rewrite");
	expect({ exit: result.exitCode, error: result.stderr.toString() }).toEqual({
		exit: 0,
		error: "",
	});
	const backup = `${f.path}.backup`;
	expect(readFileSync(backup, "utf8")).toBe(f.original);
	expect(statSync(backup).mode & 0o777).toBe(0o600);
	const migrated = readFileSync(f.path, "utf8");
	expect(JSON.parse(migrated)).toMatchObject({
		routing: { routes: { "anthropic-messages": ["anthropic"] } },
		retry_attempts: 3,
		max_body_bytes: 1234,
	});
	expect(result.stdout.toString()).toContain(backup);
	expect(f.run("config", "rewrite").exitCode).toBe(0);
	expect(readFileSync(f.path, "utf8")).toBe(migrated);
	expect(readFileSync(backup, "utf8")).toBe(f.original);
	expect(existsSync(join(f.root, "pool.db"))).toBe(false);
});

test("rewrites a pooled config into a new file without overwriting either file", () => {
	const f = fixture({
		providers: { "claude-code": { enabled: true } },
		team_routing: {
			enabled: true,
			allowlisted_account_uuids: ["seat"],
			caller_weekly_max_usage: { box: 0.7 },
			caller_provider_fallback: { box: "ordered" },
		},
		provider_pools: { "anthropic-messages": ["claude-code"] },
	});
	const output = join(f.root, "new.json");
	expect(f.run("config", "rewrite", f.path, output).exitCode).toBe(0);
	expect(readFileSync(f.path, "utf8")).toBe(f.original);
	expect(statSync(output).mode & 0o777).toBe(0o600);
	expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
		providers: {
			"claude-code": {
				pool: { members: ["seat"], caller_weekly_max_usage: { box: 0.7 } },
			},
		},
		routing: { callers: { box: { allow_fallbacks: true } } },
	});
	expect(f.run("config", "rewrite", f.path, output).exitCode).not.toBe(0);
});

test("does not overwrite a previous backup when a legacy file needs rewriting", () => {
	const f = fixture({
		provider_pools: { "anthropic-messages": ["anthropic"] },
	});
	writeFileSync(`${f.path}.backup`, "older backup");
	expect(f.run("config", "rewrite").exitCode).not.toBe(0);
	expect(readFileSync(f.path, "utf8")).toBe(f.original);
	expect(readFileSync(`${f.path}.backup`, "utf8")).toBe("older backup");
});

test("uses the default config path when no override is set", () => {
	const f = fixture({ provider_pools: { "openai-responses": ["openai"] } });
	const defaultDir = join(f.root, "agent-smith");
	mkdirSync(defaultDir);
	const defaultPath = join(defaultDir, "agent-smith.json");
	writeFileSync(defaultPath, f.original);
	const result = Bun.spawnSync(
		[
			process.execPath,
			"--no-env-file",
			process.env.AGENT_SMITH_TEST_CLI_ENTRY ??
				new URL("../main.ts", import.meta.url).pathname,
			"config",
			"rewrite",
		],
		{
			env: {
				HOME: f.root,
				XDG_CONFIG_HOME: f.root,
				PATH: "/usr/bin:/bin",
				AGENT_SMITH_DB_PATH: join(f.root, "pool.db"),
			},
		},
	);
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(readFileSync(defaultPath, "utf8"))).toHaveProperty(
		"routing",
	);
	expect(readFileSync(`${defaultPath}.backup`, "utf8")).toBe(f.original);
});

test("leaves invalid input untouched and does not create a backup", () => {
	const f = fixture({});
	writeFileSync(f.path, "{invalid json");
	const result = f.run("config", "rewrite");
	expect(result.exitCode).not.toBe(0);
	expect(readFileSync(f.path, "utf8")).toBe("{invalid json");
	expect(existsSync(`${f.path}.backup`)).toBe(false);
});

test("client status starts on a legacy config and keeps its JSON output usable", () => {
	const f = fixture({
		client: { enabled: false },
		provider_pools: { "anthropic-messages": ["anthropic"] },
	});
	const result = f.run("client", "status", "--raw");
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		enabled: false,
	});
	expect(readFileSync(`${f.path}.backup`, "utf8")).toBe(f.original);
	expect(JSON.parse(readFileSync(f.path, "utf8"))).toHaveProperty("routing");
});

test("install-client migrates a legacy config before reading client settings", () => {
	const f = fixture({
		client: { enabled: false },
		provider_pools: { "anthropic-messages": ["anthropic"] },
	});
	const result = f.run("install-client");
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toContain("client.enabled=false");
	expect(readFileSync(`${f.path}.backup`, "utf8")).toBe(f.original);
	expect(JSON.parse(readFileSync(f.path, "utf8"))).toHaveProperty("routing");
});
