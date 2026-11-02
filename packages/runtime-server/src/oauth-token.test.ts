import { afterEach, describe, expect, it, mock } from "bun:test";
import { CLAUDE_CODE_OAUTH_TOKEN_URL } from "@ccflare/providers";
import { forwardOAuthTokenRequest } from "./oauth-token";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restore();
});

describe("forwardOAuthTokenRequest", () => {
	it("passes the client token exchange through without forwarding the proxy key", async () => {
		const fetchMock = mock(async (_url: string, init: RequestInit) => {
			expect(_url).toBe(CLAUDE_CODE_OAUTH_TOKEN_URL);
			const headers = new Headers(init.headers);
			expect(headers.get("x-api-key")).toBeNull();
			expect(headers.get("host")).toBeNull();
			expect(headers.get("authorization")).toBe("Basic client-credentials");
			expect(await new Response(init.body).text()).toBe(
				'{"grant_type":"refresh_token"}',
			);
			return new Response('{"access_token":"fresh"}', { status: 200 });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await forwardOAuthTokenRequest(
			new Request("http://localhost:8080/v1/oauth/token", {
				method: "POST",
				headers: {
					Authorization: "Basic client-credentials",
					"Content-Type": "application/json",
					Host: "localhost:8080",
					"x-api-key": "proxy-key",
				},
				body: '{"grant_type":"refresh_token"}',
			}),
			new TextEncoder().encode('{"grant_type":"refresh_token"}').buffer,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('{"access_token":"fresh"}');
	});
});
