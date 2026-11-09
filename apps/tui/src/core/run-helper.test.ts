import { describe, expect, it } from "bun:test";
import {
	claudeProxyBaseUrl,
	claudeRunEnvironment,
	requireProxyKey,
} from "./run-helper";

describe("Claude run helper", () => {
	it("sets the Claude Code route and proxy credential", () => {
		expect(claudeProxyBaseUrl(8123)).toBe(
			"http://127.0.0.1:8123/v1/claude-code",
		);
		expect(
			claudeRunEnvironment(8123, "proxy-key", {
				ANTHROPIC_API_KEY: "client-key",
				ANTHROPIC_AUTH_TOKEN: "inherited-bearer-token",
				AGENT_SMITH_ADMIN_KEY: "admin-key",
				AGENT_SMITH_PROXY_KEY: "parent-proxy-key",
			}),
		).toEqual({
			ANTHROPIC_API_KEY: "proxy-key",
			ANTHROPIC_BASE_URL: "http://127.0.0.1:8123/v1/claude-code",
		});
	});

	it("uses the Anthropic protocol pool when the caller configured one", () => {
		expect(claudeProxyBaseUrl(8123, true)).toBe(
			"http://127.0.0.1:8123/v1/pool/anthropic-messages",
		);
	});

	it("requires a credential before launching Claude Code", () => {
		expect(() => requireProxyKey("")).toThrow("requires AGENT_SMITH_PROXY_KEY");
		expect(requireProxyKey("proxy-key")).toBe("proxy-key");
	});
});
