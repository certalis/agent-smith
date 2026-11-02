import { describe, expect, it } from "bun:test";
import { createConfiguredProviderRegistry } from "./index";

describe("built-in providers", () => {
	it("registers enabled providers in the expected order", () => {
		const providerRegistry = createConfiguredProviderRegistry([
			{ name: "anthropic", enabled: true, strategy: "anthropic-api" },
			{ name: "openai", enabled: true, strategy: "openai-api" },
			{ name: "claude-code", enabled: false, strategy: "claude-code" },
			{ name: "codex", enabled: false, strategy: "codex" },
		]);

		expect(providerRegistry.listProviders()).toEqual(["anthropic", "openai"]);
	});

	it("registers an enabled Claude Code provider and resolves its route", () => {
		const providerRegistry = createConfiguredProviderRegistry([
			{ name: "claude-code", enabled: true, strategy: "claude-code" },
		]);
		const provider = providerRegistry.getProvider("claude-code");
		if (!provider) {
			throw new Error("claude-code provider was not registered");
		}

		expect(providerRegistry.listProviders()).toContain("claude-code");
		expect(
			providerRegistry.resolveProvider("/v1/claude-code/v1/messages"),
		).toEqual({
			provider,
			upstreamPath: "/v1/messages",
			query: "",
		});
	});

	it("registers an enabled Codex provider and resolves its route", () => {
		const providerRegistry = createConfiguredProviderRegistry([
			{ name: "codex", enabled: true, strategy: "codex" },
		]);
		const provider = providerRegistry.getProvider("codex");
		if (!provider) {
			throw new Error("codex provider was not registered");
		}

		expect(providerRegistry.listProviders()).toContain("codex");
		expect(providerRegistry.resolveProvider("/v1/codex/responses")).toEqual({
			provider,
			upstreamPath: "/responses",
			query: "",
		});
	});
});
