import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poolEnvironment, readStandaloneOptions } from "./standalone";

const directories: string[] = [];
const environment = () => ({
	AGENT_SMITH_PUBLIC_ORIGIN: "https://pool.example.com",
	AGENT_SMITH_STATE_DIR: "/private/pool/state",
	AGENT_SMITH_ADMIN_KEY: "synthetic-admin-key-at-least-32-characters",
	AGENT_SMITH_PROXY_KEY: "synthetic-proxy-key-at-least-32-characters",
	PORT: "10000",
});

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("standalone HTTPS configuration", () => {
	test("keeps child authentication enabled and separates its port from Render's public port", () => {
		const options = readStandaloneOptions(environment());
		const child = poolEnvironment(options, {
			PORT: "10000",
			AGENT_SMITH_TRUST_LOOPBACK: "true",
			AGENT_SMITH_HOST: "0.0.0.0",
		});
		expect(child).toMatchObject({
			PORT: "8081",
			AGENT_SMITH_HOST: "127.0.0.1",
			AGENT_SMITH_TRUST_LOOPBACK: "false",
			AGENT_SMITH_CONFIG_PATH: "/private/pool/state/config.json",
			AGENT_SMITH_DB_PATH: "/private/pool/state/pool.db",
			AGENT_SMITH_CLIENT_KEYS_FILE: "/private/pool/state/clients.json",
			AGENT_SMITH_ADMIN_KEY: "synthetic-admin-key-at-least-32-characters",
			AGENT_SMITH_PROXY_KEY: "synthetic-proxy-key-at-least-32-characters",
		});
	});
	test("keeps the public entrance and private pool on distinct ports and protected paths", () => {
		const options = readStandaloneOptions(environment());
		expect(options).toMatchObject({
			origin: "https://pool.example.com",
			port: 10000,
			poolPort: 8081,
			poolHost: "127.0.0.1",
			stateDir: "/private/pool/state",
			socketPath: "/private/pool/state/control.sock",
			configPath: "/private/pool/state/config.json",
			dbPath: "/private/pool/state/pool.db",
			clientKeysFile: "/private/pool/state/clients.json",
		});
	});

	test("can use Render's assigned URL without a customer-specific host in code", () => {
		const { AGENT_SMITH_PUBLIC_ORIGIN: _, ...env } = environment();
		expect(
			readStandaloneOptions({
				...env,
				RENDER_EXTERNAL_URL: "https://assigned.example.com",
			}).origin,
		).toBe("https://assigned.example.com");
	});

	test.each([
		"http://pool.example.com",
		"https://user:secret@pool.example.com",
		"https://pool.example.com/path",
		"https://pool.example.com?query=1",
	])("refuses non-exact HTTPS origin %s", (origin) => {
		expect(() =>
			readStandaloneOptions({
				...environment(),
				AGENT_SMITH_PUBLIC_ORIGIN: origin,
			}),
		).toThrow("HTTPS origin");
	});

	test.each([
		"0",
		"65536",
		"8081",
		"not-a-port",
	])("refuses invalid or overlapping public port %s", (port) => {
		expect(() =>
			readStandaloneOptions({ ...environment(), PORT: port }),
		).toThrow("ports");
	});

	test("does not accept a shared administrator/proxy key", () => {
		const env = environment();
		expect(() =>
			readStandaloneOptions({
				...env,
				AGENT_SMITH_PROXY_KEY: env.AGENT_SMITH_ADMIN_KEY,
			}),
		).toThrow("distinct");
	});

	test("refuses relative state paths", () => {
		expect(() =>
			readStandaloneOptions({
				...environment(),
				AGENT_SMITH_STATE_DIR: "./state",
			}),
		).toThrow("absolute");
	});

	test("reads existing server keys only from an owner-only regular file", () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-smith-options-"));
		directories.push(directory);
		const keysFile = join(directory, "keys.json");
		const env: Record<string, string> = {
			...environment(),
			AGENT_SMITH_KEYS_FILE: keysFile,
		};
		delete env.AGENT_SMITH_ADMIN_KEY;
		delete env.AGENT_SMITH_PROXY_KEY;
		writeFileSync(
			keysFile,
			JSON.stringify({
				adminKey: environment().AGENT_SMITH_ADMIN_KEY,
				proxyKey: environment().AGENT_SMITH_PROXY_KEY,
			}),
			{ mode: 0o600 },
		);
		expect(readStandaloneOptions(env).adminKey).toBe(
			environment().AGENT_SMITH_ADMIN_KEY,
		);
		chmodSync(keysFile, 0o644);
		expect(() => readStandaloneOptions(env)).toThrow("private keys file");
		chmodSync(keysFile, 0o600);
		symlinkSync(keysFile, join(directory, "linked.json"));
		expect(() =>
			readStandaloneOptions({
				...env,
				AGENT_SMITH_KEYS_FILE: join(directory, "linked.json"),
			}),
		).toThrow("private keys file");
	});
});
