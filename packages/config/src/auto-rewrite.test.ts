import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logBus } from "@agent-smith/logger";
import { Config, readClientRouting } from "./index";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function fixture(value: unknown) {
	const root = mkdtempSync(join(tmpdir(), "agent-smith-auto-rewrite-"));
	directories.push(root);
	const path = join(root, "config.json");
	const source = JSON.stringify(value);
	writeFileSync(path, source, { mode: 0o600 });
	return { root, path, source, backup: `${path}.backup` };
}
const laptop = {
	lb_strategy: "session",
	client_id: "synthetic",
	client: { enabled: false },
	providers: { anthropic: { enabled: true } },
	provider_pools: { "anthropic-messages": ["anthropic"] },
	max_body_bytes: 2048,
	quota_threshold: 0.9,
	retry_attempts: 3,
	retry_delay_ms: 10,
	retry_backoff: 2,
	session_duration_ms: 1000,
};

test("startup rewrites a laptop config once, preserves its backup, and logs both paths", () => {
	const f = fixture(laptop);
	const messages: string[] = [];
	const capture = (event: { msg: string }) => {
		if (event.msg.includes(f.path)) messages.push(event.msg);
	};
	logBus.on("log", capture);
	try {
		const loaded = new Config(f.path);
		expect(loaded.getProviderPool("anthropic-messages")).toEqual(["anthropic"]);
		expect(loaded.getRuntime().maxBodyBytes).toBe(2048);
		expect(readFileSync(f.backup, "utf8")).toBe(f.source);
		expect(statSync(f.backup).mode & 0o777).toBe(0o600);
		const migrated = readFileSync(f.path, "utf8");
		expect(messages.filter((line) => line.includes(f.backup))).toHaveLength(1);
		new Config(f.path);
		expect(readFileSync(f.path, "utf8")).toBe(migrated);
		expect(readFileSync(f.backup, "utf8")).toBe(f.source);
		expect(messages.filter((line) => line.includes(f.backup))).toHaveLength(1);
	} finally {
		logBus.off("log", capture);
	}
});

test("a client launcher reload of an old config uses the same migration", () => {
	const f = fixture(laptop);
	expect(readClientRouting(f.path).enabled).toBe(false);
	expect(readFileSync(f.backup, "utf8")).toBe(f.source);
	expect(JSON.parse(readFileSync(f.path, "utf8"))).toHaveProperty("routing");
});

test("refuses an unrewritable legacy config with its reason and command", () => {
	for (const data of [
		{ team_routing: { enabled: true, unknown_option: true } },
		{ team_routing: { enabled: true }, routing: {} },
	]) {
		const f = fixture(data);
		expect(() => new Config(f.path)).toThrow(/agent-smith config rewrite/);
		expect(() => new Config(f.path)).toThrow(/unknown|both legacy/i);
		expect(readFileSync(f.path, "utf8")).toBe(f.source);
		expect(existsSync(f.backup)).toBe(false);
	}
});

test("refuses to replace a read-only legacy config without a backup", () => {
	const f = fixture(laptop);
	chmodSync(f.path, 0o400);
	try {
		expect(() => new Config(f.path)).toThrow(/agent-smith config rewrite/);
		expect(readFileSync(f.path, "utf8")).toBe(f.source);
		expect(existsSync(f.backup)).toBe(false);
	} finally {
		chmodSync(f.path, 0o600);
	}
});

test("simultaneous config loads leave one intact backup and all succeed", async () => {
	const f = fixture(laptop);
	const readyA = join(f.root, "ready-a"),
		readyB = join(f.root, "ready-b"),
		readyC = join(f.root, "ready-c"),
		go = join(f.root, "go");
	const alias = join(f.root, "linked-config.json");
	symlinkSync(f.path, alias);
	const configModule = new URL("./index.ts", import.meta.url).pathname;
	const loggerModule = new URL("../../logger/src/index.ts", import.meta.url)
		.pathname;
	const program = `import {Config} from ${JSON.stringify(configModule)}; import {logBus} from ${JSON.stringify(loggerModule)}; import {existsSync,writeFileSync} from "node:fs"; let logs=0; logBus.on("log",e=>{if(e.msg.includes("Rewrote config"))logs++}); writeFileSync(process.argv[1], "ready"); while (!existsSync(process.argv[2])) await Bun.sleep(2); const c=new Config(process.argv[3]); if(c.getProviderPool("anthropic-messages")[0]!=="anthropic") process.exit(4); console.log(logs);`;
	const spawn = (ready: string, path: string) =>
		Bun.spawn(
			[process.execPath, "--no-env-file", "-e", program, ready, go, path],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { HOME: f.root, PATH: "/usr/bin:/bin" },
			},
		);
	const a = spawn(readyA, f.path),
		b = spawn(readyB, alias),
		c = spawn(readyC, f.path);
	try {
		for (
			let n = 0;
			n < 500 &&
			!(existsSync(readyA) && existsSync(readyB) && existsSync(readyC));
			n++
		)
			await Bun.sleep(5);
		expect(existsSync(readyA) && existsSync(readyB) && existsSync(readyC)).toBe(
			true,
		);
		writeFileSync(go, "go");
		const outcomes = await Promise.all(
			[a, b, c].map(async (child) => ({
				code: await child.exited,
				error: await new Response(child.stderr).text(),
				logs: Number((await new Response(child.stdout).text()).trim()),
			})),
		);
		expect(outcomes.map(({ code, error }) => ({ code, error }))).toEqual([
			{ code: 0, error: "" },
			{ code: 0, error: "" },
			{ code: 0, error: "" },
		]);
		expect(
			outcomes.reduce((sum, outcome) => sum + outcome.logs, 0),
		).toBeGreaterThanOrEqual(1);
		expect(
			readdirSync(f.root).filter((name) =>
				name.startsWith("config.json.backup"),
			),
		).toEqual(["config.json.backup"]);
		expect(readFileSync(f.backup, "utf8")).toBe(f.source);
		expect(statSync(f.backup).mode & 0o777).toBe(0o600);
		expect(lstatSync(alias).isSymbolicLink()).toBe(true);
		expect(existsSync(`${alias}.backup`)).toBe(false);
		expect(JSON.parse(readFileSync(f.path, "utf8"))).toHaveProperty("routing");
	} finally {
		a.kill();
		b.kill();
		c.kill();
	}
}, 15_000);

test("upgrade after rollback saves the changed legacy config in another private backup", () => {
	const f = fixture(laptop);
	new Config(f.path);
	writeFileSync(f.path, readFileSync(f.backup, "utf8"));
	const changed = JSON.stringify({ ...laptop, retry_attempts: 7 });
	writeFileSync(f.path, changed);
	const messages: string[] = [];
	const capture = (event: { msg: string }) => messages.push(event.msg);
	logBus.on("log", capture);
	try {
		const config = new Config(f.path);
		expect(config.getProviderPool("anthropic-messages")).toEqual(["anthropic"]);
		const backups = readdirSync(f.root).filter((name) =>
			name.startsWith("config.json.backup-"),
		);
		expect(backups).toHaveLength(1);
		const second = join(f.root, backups[0] as string);
		expect(readFileSync(f.backup, "utf8")).toBe(f.source);
		expect(readFileSync(second, "utf8")).toBe(changed);
		expect(statSync(second).mode & 0o777).toBe(0o600);
		expect(messages.some((line) => line.includes(second))).toBe(true);
	} finally {
		logBus.off("log", capture);
	}
});

test("refuses a config the current user cannot write even when another class has a write bit", () => {
	const f = fixture(laptop);
	chmodSync(f.path, 0o420);
	try {
		expect(() => new Config(f.path)).toThrow(/agent-smith config rewrite/);
		expect(readFileSync(f.path, "utf8")).toBe(f.source);
		expect(existsSync(f.backup)).toBe(false);
	} finally {
		chmodSync(f.path, 0o600);
	}
});

test("rewrites a symlink target without replacing the config link", () => {
	const f = fixture(laptop);
	const linked = join(f.root, "linked-config.json");
	symlinkSync(f.path, linked);
	const loaded = new Config(linked);
	expect(loaded.getProviderPool("anthropic-messages")).toEqual(["anthropic"]);
	expect(lstatSync(linked).isSymbolicLink()).toBe(true);
	expect(JSON.parse(readFileSync(f.path, "utf8"))).toHaveProperty("routing");
	expect(readFileSync(f.backup, "utf8")).toBe(f.source);
});

test("can finish an interrupted or slow rewrite from the intact identical backup", () => {
	const f = fixture(laptop);
	writeFileSync(f.backup, f.source, { mode: 0o600 });
	const config = new Config(f.path);
	expect(config.getProviderPool("anthropic-messages")).toEqual(["anthropic"]);
	expect(readFileSync(f.backup, "utf8")).toBe(f.source);
});

test("unreadable and malformed configs keep the previous fallback behavior", () => {
	const f = fixture(laptop);
	writeFileSync(f.path, '{"team_routing":');
	expect(() => new Config(f.path)).not.toThrow();
	expect(() => readClientRouting(f.path)).toThrow(
		"Agent Smith client config could not be read",
	);
	expect(existsSync(f.backup)).toBe(false);
	chmodSync(f.path, 0o000);
	try {
		expect(() => new Config(f.path)).not.toThrow();
		expect(() => readClientRouting(f.path)).toThrow(
			"Agent Smith client config could not be read",
		);
	} finally {
		chmodSync(f.path, 0o600);
	}
});
