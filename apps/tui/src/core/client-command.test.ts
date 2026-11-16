import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "agent-smith-client's "));
	directories.push(root);
	const realBin = join(root, "real-bin");
	mkdirSync(realBin);
	const configPath = join(root, "agent-smith.json");
	const keyPath = join(root, "device.key");
	writeFileSync(keyPath, "synthetic-forwarding-key\n", { mode: 0o600 });
	for (const tool of ["claude", "codex"])
		writeFileSync(
			join(realBin, tool),
			`#!/bin/sh
printf '%s\\n' "url=\${ANTHROPIC_BASE_URL-unset}" "api=\${ANTHROPIC_API_KEY-unset}" "oauth=\${ANTHROPIC_AUTH_TOKEN-unset}" "proxy=\${AGENT_SMITH_PROXY_KEY-unset}" "admin=\${AGENT_SMITH_ADMIN_KEY-unset}"
printf 'arg=%s\\n' "$@"
printf 'headers=%s\\n' "\${ANTHROPIC_CUSTOM_HEADERS-unset}"
exit "\${FAKE_EXIT_CODE:-0}"
`,
			{ mode: 0o700 },
		);
	const initial = {
		retry_attempts: 7,
		client: {
			enabled: false,
			base_url: "https://pool.example.test",
			proxy_key_file: keyPath,
			keep_claude_login: false,
		},
	};
	const save = (data = initial) =>
		writeFileSync(configPath, JSON.stringify(data), { mode: 0o600 });
	save();
	const env = {
		HOME: root,
		XDG_CONFIG_HOME: root,
		SHELL: "/bin/zsh",
		PATH: `${realBin}:/usr/bin:/bin`,
		AGENT_SMITH_CONFIG_PATH: configPath,
		AGENT_SMITH_DB_PATH: join(root, "pool.db"),
	};
	const cli = (command: string, ...flags: string[]) =>
		Bun.spawnSync(
			[
				process.execPath,
				process.env.AGENT_SMITH_TEST_CLI_ENTRY ??
					new URL("../main.ts", import.meta.url).pathname,
				"client",
				command,
				...flags,
			],
			{ env },
		);
	const run = (command: string) => {
		const result = cli(command, "--raw");
		expect({
			exit: result.exitCode,
			error: result.exitCode ? result.stderr.toString() : "",
		}).toEqual({ exit: 0, error: "" });
		return JSON.parse(result.stdout.toString());
	};
	const launch = (tool: string, extra = {}) =>
		Bun.spawnSync(
			[join(root, "client-bin", tool), "two words", "$(not-a-command)"],
			{
				env: {
					...env,
					ANTHROPIC_API_KEY: "native-api",
					ANTHROPIC_AUTH_TOKEN: "native-oauth",
					AGENT_SMITH_ADMIN_KEY: "synthetic-admin",
					...extra,
				},
			},
		);
	return { root, configPath, keyPath, initial, save, cli, run, launch };
}

describe("client commands", () => {
	it("reports off without installing launchers or creating a database", () => {
		const f = fixture();
		expect(f.run("status")).toMatchObject({ enabled: false, installed: false });
		expect(existsSync(join(f.root, "pool.db"))).toBe(false);
		expect(existsSync(join(f.root, "client-bin"))).toBe(false);
	});

	it("sets up once then switches both real clients without rewriting launchers or shell settings", () => {
		const f = fixture();
		expect(f.run("on")).toMatchObject({ enabled: true, installed: true });
		const wrapper = join(f.root, "client-bin", "claude");
		const before = statSync(wrapper).ino;
		const profile = readFileSync(join(f.root, ".zshrc"), "utf8");
		expect(f.launch("claude").stdout.toString()).toContain(
			"url=https://pool.example.test/v1/claude-code\napi=synthetic-forwarding-key\noauth=unset\nproxy=unset\nadmin=unset\narg=two words\narg=$(not-a-command)",
		);
		expect(f.launch("codex").stdout.toString()).toContain(
			'model_providers.agent_smith.base_url="https://pool.example.test/v1/codex"',
		);
		expect(f.run("off")).toMatchObject({ enabled: false, installed: true });
		unlinkSync(f.keyPath);
		const native = f.launch("claude");
		expect(native.exitCode).toBe(0);
		expect(native.stdout.toString()).toContain(
			"url=unset\napi=native-api\noauth=native-oauth",
		);
		expect(f.launch("codex").stdout.toString()).not.toContain(
			"model_providers",
		);
		expect(statSync(wrapper).ino).toBe(before);
		expect(readFileSync(join(f.root, ".zshrc"), "utf8")).toBe(profile);
		expect(JSON.parse(readFileSync(f.configPath, "utf8"))).toMatchObject({
			retry_attempts: 7,
			client: { ...f.initial.client, enabled: false },
		});
		expect(statSync(f.configPath).mode & 0o777).toBe(0o600);
		writeFileSync(f.keyPath, "new-forwarding-key", { mode: 0o600 });
		f.run("on");
		expect(statSync(wrapper).ino).toBe(before);
		expect(f.launch("claude").stdout.toString()).toContain(
			"api=new-forwarding-key",
		);
		expect(readFileSync(wrapper, "utf8")).not.toContain("forwarding-key");
	});

	it("reads URL edits and the enabled flag at launch without applying the setup again", () => {
		const f = fixture();
		f.run("on");
		f.save({
			...f.initial,
			client: {
				...f.initial.client,
				enabled: true,
				base_url: "https://changed.example.test",
			},
		});
		expect(f.launch("claude").stdout.toString()).toContain(
			"url=https://changed.example.test/v1/claude-code",
		);
		f.save();
		expect(f.launch("claude").stdout.toString()).toContain("url=unset");
	});

	it("keeps the saved Claude login choice when switching and reads edits at launch", () => {
		const f = fixture();
		f.save({
			...f.initial,
			client: { ...f.initial.client, keep_claude_login: true },
		});
		f.run("on");
		const headers = { ANTHROPIC_CUSTOM_HEADERS: "x-client: preserved" };
		const login = f.launch("claude", headers);
		expect(login.exitCode).toBe(0);
		expect(login.stdout.toString()).toContain("api=unset");
		expect(login.stdout.toString()).toContain(
			"headers=x-client: preserved\nx-api-key: synthetic-forwarding-key",
		);
		f.run("off");
		expect(f.launch("claude", headers).stdout.toString()).toContain(
			"headers=x-client: preserved\n",
		);
		expect(
			JSON.parse(readFileSync(f.configPath, "utf8")).client.keep_claude_login,
		).toBe(true);
		f.run("on");
		f.save({ ...f.initial, client: { ...f.initial.client, enabled: true } });
		expect(f.launch("claude").stdout.toString()).toContain(
			"api=synthetic-forwarding-key",
		);
	});

	it("refuses a missing or unsafe forwarding key before enabling the pool", () => {
		const f = fixture();
		chmodSync(f.keyPath, 0o644);
		const result = f.cli("on", "--raw");
		expect(result.exitCode).not.toBe(0);
		expect(JSON.parse(readFileSync(f.configPath, "utf8")).client.enabled).toBe(
			false,
		);
		expect(result.stderr.toString()).not.toContain("synthetic-forwarding-key");
		expect(result.stderr.toString()).toContain("owner-only");
	});

	it("fails closed on broken enabled settings instead of falling back to native credentials", () => {
		const f = fixture();
		f.run("on");
		writeFileSync(f.configPath, '{"client":', { mode: 0o600 });
		const result = f.launch("claude");
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout.toString()).toBe("");
	});

	it("preserves the real client's exit code", () => {
		const f = fixture();
		f.run("on");
		expect(f.launch("claude", { FAKE_EXIT_CODE: "23" }).exitCode).toBe(23);
		f.run("off");
		expect(f.launch("codex", { FAKE_EXIT_CODE: "29" }).exitCode).toBe(29);
	});

	it("rejects unknown commands and flags without changing config", () => {
		const f = fixture();
		const before = readFileSync(f.configPath, "utf8");
		expect(f.cli("nope", "--raw").exitCode).not.toBe(0);
		expect(f.cli("on", "--json").exitCode).not.toBe(0);
		expect(readFileSync(f.configPath, "utf8")).toBe(before);
	});

	it("prints readable status by default and does not create a missing config", () => {
		const f = fixture();
		unlinkSync(f.configPath);
		const result = f.cli("status");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("Shared pool: off");
		expect(() => JSON.parse(result.stdout.toString())).toThrow();
		expect(existsSync(f.configPath)).toBe(false);
		expect(existsSync(join(f.root, "pool.db"))).toBe(false);
	});

	it("can turn off old generated launchers without a usable pool key", () => {
		const f = fixture();
		f.save({ ...f.initial, client: { ...f.initial.client, enabled: true } });
		const binDir = join(f.root, "client-bin");
		mkdirSync(binDir);
		writeFileSync(
			join(binDir, "claude"),
			"#!/bin/sh\necho old-pool-launcher\n",
			{ mode: 0o700 },
		);
		writeFileSync(
			join(f.root, "client-routing.json"),
			JSON.stringify({
				claudePath: join(f.root, "real-bin", "claude"),
				codexPath: join(f.root, "real-bin", "codex"),
			}),
			{ mode: 0o600 },
		);
		writeFileSync(
			join(f.root, ".zshrc"),
			'# >>> agent-smith local routing >>>\nexport PATH="' +
				binDir +
				':$PATH"\n# <<< agent-smith local routing <<<\n',
		);
		unlinkSync(f.keyPath);
		expect(f.run("off")).toMatchObject({ enabled: false, installed: true });
		expect(f.launch("claude").stdout.toString()).toContain("api=native-api");
		expect(f.launch("claude").stdout.toString()).not.toContain(
			"old-pool-launcher",
		);
	});
});
