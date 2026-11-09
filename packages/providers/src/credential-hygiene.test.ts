import { describe, expect, it } from "bun:test";
import { AnthropicProvider } from "./providers/anthropic/provider";
import { ClaudeCodeProvider } from "./providers/claude-code/provider";
import { CodexProvider } from "./providers/codex/provider";
import { OpenAIProvider } from "./providers/openai/provider";

const clientCredentials = {
	"api-key": "caller-api-key",
	authorization: "Bearer caller-owned-token",
	cookie: "session=caller-owned-cookie",
	"proxy-authorization": "Bearer caller-proxy-token",
	"x-api-key": "caller-x-api-key",
};

describe("provider credential hygiene", () => {
	it("removes incoming chunk framing before a new upstream request", () => {
		for (const provider of [
			new AnthropicProvider(),
			new ClaudeCodeProvider(),
			new CodexProvider(),
			new OpenAIProvider(),
		]) {
			const headers = provider.prepareHeaders(
				new Headers({
					"transfer-encoding": "chunked",
					"content-type": "application/json",
				}),
				null,
			);
			expect(headers.get("transfer-encoding")).toBeNull();
			expect(headers.get("content-type")).toBe("application/json");
		}
	});

	it("never forwards a client credential when the selected account has none", () => {
		for (const provider of [
			new AnthropicProvider(),
			new ClaudeCodeProvider(),
			new CodexProvider(),
			new OpenAIProvider(),
		]) {
			const headers = provider.prepareHeaders(
				new Headers(clientCredentials),
				null,
			);

			for (const name of Object.keys(clientCredentials)) {
				expect(headers.get(name)).toBeNull();
			}
		}
	});
});
