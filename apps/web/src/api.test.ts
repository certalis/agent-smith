import { afterEach, describe, expect, it, mock } from "bun:test";
import { api } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
	api.clearAdminKey();
	globalThis.fetch = originalFetch;
});

describe("dashboard API admin authorization", () => {
	it("authenticates caller usage reads, encodes filters and forgets authorization when locked", async () => {
		const calls: Array<{ path: string; key: string | null }> = [];
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					path: String(input),
					key: new Headers(init?.headers).get("x-api-key"),
				});
				return Response.json({ startMs: 0, endMs: 1, rows: [], models: [] });
			},
			{ preconnect: originalFetch.preconnect },
		);
		api.setAdminKey("synthetic-admin-key");
		await api.getCallerUsage({
			range: "7d",
			model: "model/a+b",
			caller: "build-runner",
		});
		api.clearAdminKey();
		await api.getCallerUsage({ range: "24h" });
		expect(calls).toEqual([
			{
				path: "/api/usage/callers?range=7d&model=model%2Fa%2Bb&caller=build-runner",
				key: "synthetic-admin-key",
			},
			{ path: "/api/usage/callers?range=24h", key: null },
		]);
	});
	it("authenticates reset inspection and never automatically retries consuming a grant", async () => {
		const calls: Array<{
			path: string;
			method: string;
			key: string | null;
			body: unknown;
		}> = [];
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					path: String(input),
					method: init?.method ?? "GET",
					key: new Headers(init?.headers).get("x-api-key"),
					body: init?.body ? JSON.parse(String(init.body)) : null,
				});
				return Response.json(
					init?.method === "POST"
						? { error: "uncertain reset" }
						: { availableCount: 0, credits: [] },
					{ status: init?.method === "POST" ? 502 : 200 },
				);
			},
			{ preconnect: originalFetch.preconnect },
		);
		api.setAdminKey("admin-secret");
		await api.getResetCredits("account-a");
		const attempt = {
			creditId: "grant-a",
			requestId: "d1ee712f-992d-4a86-8fe4-11b1da30fbc4",
		};
		await expect(
			api.consumeResetCredit("account-a", attempt),
		).rejects.toThrow();
		expect(calls).toEqual([
			{
				path: "/api/accounts/account-a/reset-credits",
				method: "GET",
				key: "admin-secret",
				body: null,
			},
			{
				path: "/api/accounts/account-a/reset-credits/consume",
				method: "POST",
				key: "admin-secret",
				body: { ...attempt, confirmed: true },
			},
		]);
	});
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
