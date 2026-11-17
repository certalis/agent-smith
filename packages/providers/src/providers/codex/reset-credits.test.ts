import { afterEach, describe, expect, it } from "bun:test";
import {
	createJsonFetchMock,
	createOAuthAccount,
	originalFetch,
} from "../../test-helpers";
import { CodexProvider } from "./provider";

const account = createOAuthAccount("codex", {
	account_uuid: "synthetic-workspace",
});
const requestId = "9db5702f-14d7-4ea3-999d-95ef8eb437ac";

describe("manual Codex reset credits", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});
	it("refreshes only known provider windows without marking every window rejected by an aggregate limit", async () => {
		const seconds = Math.floor(Date.now() / 1000) + 18_000;
		globalThis.fetch = createJsonFetchMock({
			rate_limit: {
				limit_reached: true,
				primary_window: {
					used_percent: 15,
					reset_at: seconds,
					limit_window_seconds: 18_000,
				},
				secondary_window: {
					used_percent: 100,
					reset_at: seconds + 604_800,
					limit_window_seconds: 604_800,
				},
			},
		});
		const quota = await new CodexProvider().readResetQuota(
			account,
			"saved-token",
		);
		expect(quota?.windows.unified5h).toMatchObject({
			utilization: 0.15,
			status: null,
		});
		expect(quota?.windows.unified7d).toMatchObject({
			utilization: 1,
			status: null,
		});
	});

	it("lists only safe credit fields at the fixed origin with saved account credentials", async () => {
		globalThis.fetch = createJsonFetchMock(
			{
				available_count: 1,
				credentials: "never-forward",
				credits: [
					{
						id: "grant-a",
						reset_type: "codex_rate_limits",
						status: "available",
						granted_at: "2026-01-01T00:00:00Z",
						expires_at: null,
						title: "Full reset",
						description: null,
						token: "never-forward",
					},
				],
			},
			(req) => {
				expect(req.url).toBe(
					"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
				);
				expect(req.method).toBe("GET");
				expect(req.redirect).toBe("error");
				expect(req.headers.get("authorization")).toBe("Bearer saved-token");
				expect(req.headers.get("chatgpt-account-id")).toBe(
					"synthetic-workspace",
				);
			},
		);
		const provider = new CodexProvider();
		expect(await provider.listResetCredits(account, "saved-token")).toEqual({
			availableCount: 1,
			credits: [
				{
					id: "grant-a",
					resetType: "codex_rate_limits",
					status: "available",
					grantedAt: "2026-01-01T00:00:00Z",
					expiresAt: null,
					title: "Full reset",
					description: null,
				},
			],
		});
	});

	it.each([
		"reset",
		"nothing_to_reset",
		"no_credit",
		"already_redeemed",
	] as const)("preserves the provider's %s outcome and stable redemption identity", async (code) => {
		globalThis.fetch = createJsonFetchMock(
			{ code, windows_reset: code === "reset" ? 2 : 0 },
			async (req) => {
				expect(req.url).toBe(
					"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
				);
				expect(req.method).toBe("POST");
				expect(req.redirect).toBe("error");
				expect(await req.json()).toEqual({
					credit_id: "grant-a",
					redeem_request_id: requestId,
				});
			},
		);
		expect(
			await new CodexProvider().consumeResetCredit(account, "saved-token", {
				creditId: "grant-a",
				requestId,
			}),
		).toEqual({ code, windowsReset: code === "reset" ? 2 : 0 });
	});

	it.each([
		{ code: "new-unknown-result" },
		{ code: "reset", windows_reset: -1 },
		{ available_count: -1, credits: [] },
		{ available_count: 1, credits: [{ id: "invalid" }] },
	])("rejects malformed provider data without treating it as recovery", async (payload) => {
		globalThis.fetch = createJsonFetchMock(payload);
		const provider = new CodexProvider();
		const call =
			"code" in payload
				? provider.consumeResetCredit(account, "saved-token", {
						creditId: "grant-a",
						requestId,
					})
				: provider.listResetCredits(account, "saved-token");
		await expect(call).rejects.toThrow("Invalid Codex reset response");
	});

	it("does not send credentials to a custom upstream or expose upstream error bodies", async () => {
		let calls = 0;
		globalThis.fetch = createJsonFetchMock(
			{ error: "secret-from-provider" },
			() => {
				calls++;
			},
			{ status: 503 },
		);
		await expect(
			new CodexProvider().listResetCredits(
				{ ...account, base_url: "https://other.example" },
				"saved-token",
			),
		).rejects.toThrow("Reset credits require a direct Codex subscription");
		expect(calls).toBe(0);
		await expect(
			new CodexProvider().listResetCredits(account, "saved-token"),
		).rejects.toThrow("Codex reset request failed (503)");
	});
});
