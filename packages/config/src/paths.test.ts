import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveConfigPath } from "./paths";
import { getPlatformConfigDir } from "./paths-common";

const original = { ...process.env };
afterEach(() => {
	process.env = { ...original };
});

test("loads the Agent Smith configuration selected by its uppercase environment variable", () => {
	process.env.AGENT_SMITH_CONFIG_PATH = "/private/config/agent-smith.json";
	expect(resolveConfigPath()).toBe("/private/config/agent-smith.json");
});

test("defaults to the Agent Smith directory and filename under XDG_CONFIG_HOME", () => {
	delete process.env.AGENT_SMITH_CONFIG_PATH;
	process.env.XDG_CONFIG_HOME = "/private/config";
	expect(getPlatformConfigDir()).toBe("/private/config/agent-smith");
	expect(resolveConfigPath()).toBe(
		join("/private/config/agent-smith", "agent-smith.json"),
	);
});
