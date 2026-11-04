import { describe, expect, it } from "bun:test";
import type { Account } from "@ccflare/types";
import {
	createConfiguredProviderRegistry,
	type Provider,
	ProviderRegistry,
	type RateLimitInfo,
	type TokenRefreshResult,
} from "./index";

function createTestProvider(name: string): Provider {
	return {
		name,
		defaultBaseUrl: `https://${name}.example.com`,
		wire: "anthropic-messages",
		async refreshToken(
			_account: Account,
			_clientId: string,
		): Promise<TokenRefreshResult> {
			throw new Error("not implemented");
		},
		buildUrl(upstreamPath: string, query: string, account?: Account): string {
			return `${account?.base_url ?? this.defaultBaseUrl}${upstreamPath}${query}`;
		},
		prepareHeaders(headers: Headers, _account: Account | null): Headers {
			return new Headers(headers);
		},
		parseRateLimit(): RateLimitInfo {
			return { isRateLimited: false };
		},
		quotaBucketsFor() {
			return undefined;
		},
		weeklyBucketFor() {
			return undefined;
		},
		isWeeklyBucket() {
			return false;
		},
		isFiveHourBucket() {
			return false;
		},
		supportsQuotaProbe() {
			return false;
		},
		async probeQuota() {
			return null;
		},
		async processResponse(response: Response): Promise<Response> {
			return response;
		},
	};
}

describe("ProviderRegistry", () => {
	it("builds only enabled providers and gives a configured endpoint its own route", () => {
		const registry = createConfiguredProviderRegistry([
			{
				name: "anthropic",
				enabled: true,
				strategy: "anthropic-api",
			},
			{
				name: "claude-code",
				enabled: false,
				strategy: "claude-code",
			},
			{
				name: "acme",
				enabled: true,
				strategy: "anthropic-api",
				baseUrl: "https://api.acme.test",
			},
		]);

		expect(registry.listProviders()).toEqual(["anthropic", "acme"]);
		expect(registry.resolveProvider("/v1/claude-code/v1/messages")).toBeNull();
		expect(registry.resolveProvider("/v1/acme/v1/messages")).toMatchObject({
			upstreamPath: "/v1/messages",
		});
		expect(registry.getProvider("acme")?.buildUrl("/v1/messages", "")).toBe(
			"https://api.acme.test/v1/messages",
		);
	});

	it("resolves an ordered same-wire pool and maps only configured model names", () => {
		const registry = createConfiguredProviderRegistry(
			[
				{
					name: "anthropic",
					enabled: true,
					strategy: "anthropic-api",
				},
				{
					name: "acme",
					enabled: true,
					strategy: "anthropic-api",
					models: {
						"claude-opus-4": "acme-opus",
						"claude-sonnet-*": "acme-sonnet",
					},
				},
				{
					name: "codex",
					enabled: true,
					strategy: "codex",
				},
			],
			{
				"anthropic-messages": ["acme", "anthropic", "acme", "codex"],
			},
		);

		expect(
			registry.resolvePool(
				"/v1/pool/anthropic-messages/v1/messages",
				"claude-sonnet-4-5",
			),
		).toMatchObject({
			upstreamPath: "/v1/messages",
			wire: "anthropic-messages",
			providers: [
				{ model: "acme-sonnet", provider: { name: "acme" } },
				{ model: "claude-sonnet-4-5", provider: { name: "anthropic" } },
			],
		});
		expect(
			registry.resolvePool(
				"/v1/pool/anthropic-messages/v1/messages",
				"gpt-5.6-sol",
			),
		).toMatchObject({ providers: [{ model: "gpt-5.6-sol" }] });
		expect(
			registry.resolvePool(
				"/v1/pool/anthropic-messages/v1/messages",
				"unknown",
			),
		).toMatchObject({ providers: [{ provider: { name: "anthropic" } }] });
	});

	it("registers multiple providers and resolves a valid Anthropic path", () => {
		const anthropic = createTestProvider("anthropic");
		const openai = createTestProvider("openai");
		const registry = new ProviderRegistry([anthropic, openai]);

		expect(registry.getProvider("anthropic")?.name).toBe("anthropic");
		expect(registry.getProvider("openai")?.name).toBe("openai");
		expect(registry.listProviders()).toEqual(["anthropic", "openai"]);
		expect(registry.resolveProvider("/v1/anthropic/v1/messages")).toEqual({
			provider: anthropic,
			upstreamPath: "/v1/messages",
			query: "",
		});
	});

	it("resolves a valid OpenAI path", () => {
		const openai = createTestProvider("openai");
		const registry = new ProviderRegistry([openai]);

		expect(registry.resolveProvider("/v1/openai/responses")).toEqual({
			provider: openai,
			upstreamPath: "/responses",
			query: "",
		});
	});

	it("returns null for an unknown provider", () => {
		const registry = new ProviderRegistry([createTestProvider("anthropic")]);

		expect(registry.resolveProvider("/v1/unknown/foo")).toBeNull();
	});

	it("returns null for a bare /v1/ path", () => {
		const registry = new ProviderRegistry([createTestProvider("anthropic")]);

		expect(registry.resolveProvider("/v1/")).toBeNull();
	});

	it("matches providers case-sensitively", () => {
		const registry = new ProviderRegistry([createTestProvider("anthropic")]);

		expect(registry.resolveProvider("/v1/Anthropic/v1/messages")).toBeNull();
	});

	it("strips the provider prefix exactly once", () => {
		const anthropic = createTestProvider("anthropic");
		const registry = new ProviderRegistry([anthropic]);

		expect(
			registry.resolveProvider("/v1/anthropic/v1/anthropic/v1/messages"),
		).toEqual({
			provider: anthropic,
			upstreamPath: "/v1/anthropic/v1/messages",
			query: "",
		});
	});
});
