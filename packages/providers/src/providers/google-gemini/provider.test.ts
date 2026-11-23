import { describe, expect, it } from "bun:test";
import { createApiKeyAccount, expectRemovedHeaders } from "../../test-helpers";
import { GoogleGeminiProvider } from "./provider";

const decode = (body: ArrayBuffer) =>
	JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;

describe("GoogleGeminiProvider", () => {
	it("converts a Messages request into Gemini's mapped native endpoint", () => {
		const provider = new GoogleGeminiProvider();
		const transformed = provider.transformRequest?.({
			body: new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					max_tokens: 24,
					messages: [{ role: "user", content: "Say hi" }],
				}),
			).buffer,
			headers: new Headers(),
			mappedModel: "gemini-2.5-flash",
			query: "",
			upstreamPath: "/v1/messages",
		});

		expect(transformed).toEqual({
			body: expect.any(ArrayBuffer),
			query: "",
			upstreamPath: "/v1beta/models/gemini-2.5-flash:generateContent",
		});
		if (!transformed?.body) throw new Error("Expected transformed body");
		expect(decode(transformed.body)).toEqual({
			contents: [{ role: "user", parts: [{ text: "Say hi" }] }],
			generationConfig: { maxOutputTokens: 24 },
		});
		expect(provider.buildUrl(transformed.upstreamPath, transformed.query)).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
		);
	});

	it("uses only the selected account API key and removes Anthropic credentials", () => {
		const provider = new GoogleGeminiProvider();
		const headers = provider.prepareHeaders(
			new Headers({
				"api-key": "caller-api-key",
				"anthropic-beta": "prompt-caching-2024-07-31",
				"anthropic-version": "2023-06-01",
				"x-api-key": "caller-x-api-key",
				"x-goog-api-key": "caller-google-key",
			}),
			createApiKeyAccount("gemini", { api_key: "google-selected-key" }),
		);

		expect(headers.get("x-goog-api-key")).toBe("google-selected-key");
		expectRemovedHeaders(headers, [
			"api-key",
			"anthropic-beta",
			"anthropic-version",
			"x-api-key",
		]);
	});

	it("never forwards a caller-supplied Google key without a selected account", () => {
		const provider = new GoogleGeminiProvider();
		const headers = provider.prepareHeaders(
			new Headers({ "x-goog-api-key": "caller-google-key" }),
			null,
		);

		expect(headers.get("x-goog-api-key")).toBeNull();
	});

	it("rejects an Anthropic beta request before native forwarding", () => {
		const provider = new GoogleGeminiProvider();

		expect(() =>
			provider.transformRequest?.({
				body: new TextEncoder().encode(
					JSON.stringify({
						model: "claude-sonnet-4-5",
						max_tokens: 24,
						messages: [{ role: "user", content: "Say hi" }],
					}),
				).buffer,
				headers: new Headers({
					"anthropic-beta": "computer-use-2025-01-24",
				}),
				mappedModel: "gemini-2.5-flash",
				query: "",
				upstreamPath: "/v1/messages",
			}),
		).toThrow("Gemini adapter does not support Anthropic beta features");
	});

	it("returns Anthropic-shaped responses while leaving rate-limit facts neutral", async () => {
		const provider = new GoogleGeminiProvider();
		const response = await provider.processResponse(
			new Response(
				JSON.stringify({
					candidates: [
						{
							content: { role: "model", parts: [{ text: "Hi" }] },
							finishReason: "STOP",
						},
					],
					usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
				}),
				{ headers: { "content-type": "application/json" } },
			),
			null,
			{ messageId: "msg_google_provider", model: "gemini-2.5-flash" },
		);

		expect(await response.json()).toMatchObject({
			id: "msg_google_provider",
			model: "gemini-2.5-flash",
			content: [{ type: "text", text: "Hi" }],
		});
		expect(
			provider.parseRateLimit(
				new Response("too many requests", {
					status: 429,
					headers: { "retry-after": "4" },
				}),
			),
		).toMatchObject({ isRateLimited: true });
	});
});
