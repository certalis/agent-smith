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
	unlinkSync,
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
		expect(outcomes.reduce((sum, outcome) => sum + outcome.logs, 0)).toBe(1);
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

test("an older backup is never replaced by an automatic migration", () => {
	const f = fixture(laptop);
	writeFileSync(f.backup, "previous backup", { mode: 0o600 });
	expect(() => new Config(f.path)).toThrow(/agent-smith config rewrite/);
	expect(readFileSync(f.path, "utf8")).toBe(f.source);
	expect(readFileSync(f.backup, "utf8")).toBe("previous backup");
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

test("refuses an unreadable existing config instead of starting with defaults", () => {
	const f = fixture(laptop);
	chmodSync(f.path, 0o000);
	try {
		expect(() => new Config(f.path)).toThrow(/agent-smith config rewrite/);
		expect(existsSync(f.backup)).toBe(false);
	} finally {
		chmodSync(f.path, 0o600);
	}
});

test("refuses malformed existing config instead of starting with defaults", () => {
	const f = fixture(laptop);
	writeFileSync(f.path, '{"team_routing":');
	expect(() => new Config(f.path)).toThrow(/agent-smith config rewrite/);
	expect(existsSync(f.backup)).toBe(false);
});

test("a concurrent load waits for a slow live rewrite owner", async () => {
	const f = fixture(laptop);
	const lock = join(f.root, ".config.json.rewrite.lock");
	const owner = Bun.spawn(
		[process.execPath, "--no-env-file", "-e", "await Bun.sleep(10000)"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	writeFileSync(lock, JSON.stringify({ pid: owner.pid }), { mode: 0o600 });
	const modulePath = new URL("./index.ts", import.meta.url).pathname;
	const program = `import {Config} from ${JSON.stringify(modulePath)}; const c=new Config(process.argv[1]); if(c.getProviderPool("anthropic-messages")[0]!=="anthropic") process.exit(4);`;
	const waiting = Bun.spawn(
		[process.execPath, "--no-env-file", "-e", program, f.path],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { HOME: f.root, PATH: "/usr/bin:/bin" },
		},
	);
	try {
		await Bun.sleep(2200);
		expect(waiting.exitCode).toBeNull();
		rmSync(lock);
		const [code, error] = await Promise.all([
			waiting.exited,
			new Response(waiting.stderr).text(),
		]);
		expect({ code, error }).toEqual({ code: 0, error: "" });
		expect(readFileSync(f.backup, "utf8")).toBe(f.source);
	} finally {
		owner.kill();
		waiting.kill();
	}
}, 10_000);

test("a lock left by a stopped process refuses safely with recovery details", async () => {
	const f = fixture(laptop);
	const owner = Bun.spawn([process.execPath, "--no-env-file", "-e", ""], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await owner.exited;
	const lock = join(f.root, ".config.json.rewrite.lock");
	writeFileSync(lock, JSON.stringify({ pid: owner.pid }), { mode: 0o600 });
	expect(() => new Config(f.path)).toThrow(
		/stopped process.*agent-smith config rewrite/i,
	);
	expect(readFileSync(f.path, "utf8")).toBe(f.source);
	expect(existsSync(f.backup)).toBe(false);
});

test("a live lock that never clears eventually refuses with a useful reason", async () => {
	const f = fixture(laptop);
	const lock = join(f.root, ".config.json.rewrite.lock");
	writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
	const modulePath = new URL("./index.ts", import.meta.url).pathname;
	const program = `import {Config} from ${JSON.stringify(modulePath)}; let tick=0; Date.now=()=>tick++===0?0:31000; try { new Config(process.argv[1]); process.exit(5); } catch (e) { console.log(e.message); }`;
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", "-e", program, f.path],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { HOME: f.root, PATH: "/usr/bin:/bin" },
		},
	);
	const [code, output] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
	]);
	expect(code).toBe(0);
	expect(output).toMatch(/still running.*agent-smith config rewrite/i);
	expect(readFileSync(f.path, "utf8")).toBe(f.source);
	expect(existsSync(f.backup)).toBe(false);
});

test("a retargeted config link stops waiting for the old target", async () => {
	const f = fixture(laptop);
	const other = join(f.root, "other.json");
	const alias = join(f.root, "linked.json");
	const lock = join(f.root, ".config.json.rewrite.lock");
	writeFileSync(other, f.source, { mode: 0o600 });
	symlinkSync(f.path, alias);
	writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
	const modulePath = new URL("./index.ts", import.meta.url).pathname;
	const program = `import {Config} from ${JSON.stringify(modulePath)}; const c=new Config(process.argv[1]); if(c.getProviderPool("anthropic-messages")[0]!=="anthropic")process.exit(4);`;
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", "-e", program, alias],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { HOME: f.root, PATH: "/usr/bin:/bin" },
		},
	);
	try {
		for (
			let n = 0;
			n < 500 &&
			!readdirSync(f.root).some((name) => name.endsWith(".lock.tmp"));
			n++
		)
			await Bun.sleep(5);
		expect(readdirSync(f.root).some((name) => name.endsWith(".lock.tmp"))).toBe(
			true,
		);
		unlinkSync(alias);
		symlinkSync(other, alias);
		const code = await Promise.race([
			child.exited,
			Bun.sleep(3000).then(() => -1),
		]);
		if (code === -1) child.kill();
		const error = await new Response(child.stderr).text();
		expect({ code, error }).toEqual({ code: 0, error: "" });
		expect(JSON.parse(readFileSync(other, "utf8"))).toHaveProperty("routing");
		expect(readFileSync(`${other}.backup`, "utf8")).toBe(f.source);
	} finally {
		child.kill();
	}
}, 10_000);

test("a client reread reports why an unreadable config cannot migrate", () => {
	const f = fixture(laptop);
	chmodSync(f.path, 0o000);
	try {
		expect(() => readClientRouting(f.path)).toThrow(
			/agent-smith config rewrite/,
		);
		expect(existsSync(f.backup)).toBe(false);
	} finally {
		chmodSync(f.path, 0o600);
	}
});

test("an owner that finishes just before its PID is checked is not mistaken for a stale lock", async () => {
	const f = fixture(laptop);
	const lock = join(f.root, ".config.json.rewrite.lock");
	writeFileSync(lock, JSON.stringify({ pid: 99999999 }), { mode: 0o600 });
	const modulePath = new URL("./index.ts", import.meta.url).pathname;
	const program = `import {Config,rewriteLegacyConfig} from ${JSON.stringify(modulePath)}; import {readFileSync,writeFileSync,unlinkSync} from "node:fs"; const path=process.argv[1], lock=process.argv[2]; process.kill=()=>{const old=JSON.parse(readFileSync(path,"utf8")); writeFileSync(path+".backup",JSON.stringify(old),{mode:0o600}); writeFileSync(path,JSON.stringify(rewriteLegacyConfig(old)),{mode:0o600}); unlinkSync(lock); throw Object.assign(new Error("gone"),{code:"ESRCH"});}; const c=new Config(path); if(c.getProviderPool("anthropic-messages")[0]!=="anthropic")process.exit(4);`;
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", "-e", program, f.path, lock],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { HOME: f.root, PATH: "/usr/bin:/bin" },
		},
	);
	const [code, error] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	expect({ code, error }).toEqual({ code: 0, error: "" });
	expect(readFileSync(f.backup, "utf8")).toBe(f.source);
});
