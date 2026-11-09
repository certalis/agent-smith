import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStandaloneOptions } from "@agent-smith/config/standalone";
import { prepareStandaloneState } from "./standalone";

const directories: string[] = [];
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-state-"));
	directories.push(directory);
	return readStandaloneOptions({
		AGENT_SMITH_PUBLIC_ORIGIN: "https://pool.example.com",
		AGENT_SMITH_STATE_DIR: directory,
		AGENT_SMITH_ADMIN_KEY: "synthetic-admin-key-at-least-32-characters",
		AGENT_SMITH_PROXY_KEY: "synthetic-proxy-key-at-least-32-characters",
	});
}
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

test("creates private state but does not replace a file at the control path", async () => {
	const options = fixture();
	await prepareStandaloneState(options);
	writeFileSync(options.socketPath, "keep this operator file", { mode: 0o600 });
	await expect(prepareStandaloneState(options)).rejects.toThrow("not a socket");
	expect(existsSync(options.socketPath)).toBe(true);
});

test("refuses a shared or symlinked state directory", async () => {
	const options = fixture();
	chmodSync(options.stateDir, 0o755);
	await expect(prepareStandaloneState(options)).rejects.toThrow(
		"state directory",
	);
	chmodSync(options.stateDir, 0o700);
	const linked = join(options.stateDir, "linked");
	symlinkSync(options.stateDir, linked);
	await expect(
		prepareStandaloneState({ ...options, stateDir: linked }),
	).rejects.toThrow("state directory");
});

test.each([
	"configPath",
	"dbPath",
	"clientKeysFile",
] as const)("refuses a readable or symlinked %s", async (field) => {
	const options = fixture();
	const path = options[field];
	writeFileSync(path, "{}", { mode: 0o644 });
	await expect(prepareStandaloneState(options)).rejects.toThrow("state files");
	chmodSync(path, 0o600);
	await prepareStandaloneState(options);
	const linked = join(options.stateDir, "linked");
	symlinkSync(path, linked);
	await expect(
		prepareStandaloneState({ ...options, [field]: linked }),
	).rejects.toThrow("state files");
});
