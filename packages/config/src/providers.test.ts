import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function configFrom(data: unknown): Config {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-config-"));
	tempDirs.push(directory);
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(data));
	return new Config(path);
}

const EXAMPLES_DIR = join(import.meta.dir, "../../../examples/config");
const API_KEY_EXAMPLES = [
	"anthropic-api-key.json",
	"openai-api-key.json",
	"compatible-endpoint-fallback.json",
];

function exampleConfig(name: string): Config {
	return configFrom(JSON.parse(readFileSync(join(EXAMPLES_DIR, name), "utf8")));
}

describe("provider configuration", () => {
	it.each([
		["absent client", {}, false],
		[
			"missing enabled",
			{ client: { base_url: "https://pool.example" } },
			false,
		],
		["explicitly disabled", { client: { enabled: false } }, false],
		["invalid truthy value", { client: { enabled: "true" } }, false],
		["explicitly enabled", { client: { enabled: true } }, true],
	])("requires literal true to enable client routing: %s", (_name, data, enabled) => {
		expect(configFrom(data).getClientRouting().enabled).toBe(enabled);
	});

	it("reads the Agent Smith endpoint and forwarding-key file used by clients", () => {
		const config = configFrom({
			client: {
				base_url: "http://127.0.0.1:18181/",
				proxy_key_file: "/tmp/agent-smith.key",
				keep_claude_login: true,
			},
		});

		expect(config.getClientRouting()).toEqual({
			enabled: false,
			baseUrl: "http://127.0.0.1:18181",
			proxyKeyFile: "/tmp/agent-smith.key",
			keepClaudeLogin: true,
		});
	});

	it("does not retain a raw forwarding key from client config", () => {
		const config = configFrom({
			client: {
				base_url: "http://127.0.0.1:18181",
				proxy_key: "not-allowed-in-config",
			},
		});

		expect(config.getClientRouting()).toEqual({
			enabled: false,
			baseUrl: "http://127.0.0.1:18181",
		});
	});

	it("enables API-key providers but leaves subscription sign-ins off by default", () => {
		const config = configFrom({});

		expect(config.getProviderConfig("anthropic")).toMatchObject({
			enabled: true,
			strategy: "anthropic-api",
		});
		expect(config.getProviderConfig("openai")).toMatchObject({
			enabled: true,
			strategy: "openai-api",
		});
		expect(config.getProviderConfig("claude-code")).toMatchObject({
			enabled: false,
			strategy: "claude-code",
		});
		expect(config.getProviderConfig("codex")).toMatchObject({
			enabled: false,
			strategy: "codex",
		});
	});

	it("adds a named Anthropic-compatible provider and explicitly enables Claude Code", () => {
		const config = configFrom({
			providers: {
				acme: {
					strategy: "anthropic-api",
					base_url: "https://api.acme.test/",
				},
				"claude-code": { enabled: true },
			},
		});

		expect(config.getProviderConfig("acme")).toEqual({
			name: "acme",
			enabled: true,
			strategy: "anthropic-api",
			baseUrl: "https://api.acme.test",
		});
		expect(config.getProviderConfig("claude-code")).toMatchObject({
			enabled: true,
			strategy: "claude-code",
		});
	});

	it("keeps only enabled, same-wire provider-pool entries and provider model maps", () => {
		const config = configFrom({
			providers: {
				acme: {
					strategy: "anthropic-api",
					models: {
						"claude-opus-4": "acme-opus",
						"claude-sonnet-*": "acme-sonnet",
					},
				},
				"claude-code": { enabled: true },
				codex: { enabled: true },
			},
			provider_pools: {
				"anthropic-messages": [
					"claude-code",
					"acme",
					"acme",
					"codex",
					"missing",
				],
			},
		});

		expect(config.getProviderConfig("acme")).toMatchObject({
			models: {
				"claude-opus-4": "acme-opus",
				"claude-sonnet-*": "acme-sonnet",
			},
		});
		expect(config.getProviderPool("anthropic-messages")).toEqual([
			"claude-code",
			"acme",
		]);
	});

	it("reserves pool as the protocol route name", () => {
		const config = configFrom({
			providers: { pool: { strategy: "anthropic-api" } },
		});

		expect(config.getProviderConfig("pool")).toBeUndefined();
	});
});

describe("README example configurations", () => {
	it("route each API-key protocol pool through the providers it names", () => {
		expect(
			exampleConfig("anthropic-api-key.json").getProviderPool(
				"anthropic-messages",
			),
		).toEqual(["anthropic"]);
		expect(
			exampleConfig("openai-api-key.json").getProviderPool("openai-responses"),
		).toEqual(["openai"]);

		const fallback = exampleConfig("compatible-endpoint-fallback.json");
		expect(fallback.getProviderPool("anthropic-messages")).toEqual([
			"anthropic",
			"acme",
		]);
		expect(fallback.getProviderConfig("acme")).toMatchObject({
			enabled: true,
			strategy: "anthropic-api",
			baseUrl: "https://api.acme.example",
			models: { "claude-sonnet-*": "acme-large" },
		});
	});

	it("leave subscription sign-ins off outside the example-only files", () => {
		for (const name of API_KEY_EXAMPLES) {
			const config = exampleConfig(name);
			expect(config.getProviderConfig("claude-code")?.enabled).toBe(false);
			expect(config.getProviderConfig("codex")?.enabled).toBe(false);
		}

		expect(
			exampleConfig(
				"example-only-claude-code-subscription.json",
			).getProviderConfig("claude-code")?.enabled,
		).toBe(true);
		expect(
			exampleConfig("example-only-codex-subscription.json").getProviderConfig(
				"codex",
			)?.enabled,
		).toBe(true);
	});
});
