import { afterEach, describe, expect, it, mock } from "bun:test";
import { api } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
	api.clearAdminKey();
	globalThis.fetch = originalFetch;
});

describe("dashboard API admin authorization", () => {
	it("sends the session-only admin key with management writes", async () => {
		let sentHeaders: Headers | undefined;
		const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => {
			sentHeaders = new Headers(init?.headers);
			return Promise.resolve(
				new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				}),
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		api.setAdminKey("admin-secret");

		await api.resetStats();

		expect(sentHeaders?.get("x-api-key")).toBe("admin-secret");
	});

	it("does not retain the admin key after it is locked", async () => {
		let sentHeaders: Headers | undefined;
		const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => {
			sentHeaders = new Headers(init?.headers);
			return Promise.resolve(
				new Response(JSON.stringify({}), {
					headers: { "Content-Type": "application/json" },
				}),
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		api.setAdminKey("admin-secret");
		api.clearAdminKey();

		await api.resetStats();

		expect(sentHeaders?.get("x-api-key")).toBeNull();
	});
});
