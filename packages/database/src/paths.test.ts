import { afterEach, expect, test } from "bun:test";
import { resolveDbPath } from "./paths";

const original = { ...process.env };
afterEach(() => {
	process.env = { ...original };
});

test("opens the database selected by AGENT_SMITH_DB_PATH", () => {
	process.env.AGENT_SMITH_DB_PATH = "/private/state/pool.db";
	expect(resolveDbPath()).toBe("/private/state/pool.db");
});

test("defaults to the Agent Smith database under XDG_CONFIG_HOME", () => {
	delete process.env.AGENT_SMITH_DB_PATH;
	process.env.XDG_CONFIG_HOME = "/private/config";
	expect(resolveDbPath()).toBe("/private/config/agent-smith/agent-smith.db");
});
