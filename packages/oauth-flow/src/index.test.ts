import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@agent-smith/config";
import { DatabaseFactory } from "@agent-smith/database";
import { createOAuthFlow } from "./index";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

function unsignedJwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function createTestContext(configData?: Record<string, unknown>) {
	const tempDir = mkdtempSync(join(tmpdir(), "agent-smith-oauth-flow-"));
	tempDirs.push(tempDir);

	const configPath = join(tempDir, "config.json");
	const configuredProviders =
		typeof configData?.providers === "object" &&
		configData.providers !== null &&
		!Array.isArray(configData.providers)
			? (configData.providers as Record<string, unknown>)
			: {};
	writeFileSync(
		configPath,
		JSON.stringify({
			...configData,
			providers: {
				"claude-code": { enabled: true },
				codex: { enabled: true },
				...configuredProviders,
			},
		}),
		"utf8",
	);
	const config = new Config(configPath);
	DatabaseFactory.reset();
	DatabaseFactory.initialize(join(tempDir, "agent-smith.db"));
	const dbOps = DatabaseFactory.getInstance();

	return { config, dbOps };
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	DatabaseFactory.reset();

	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { force: true, recursive: true });
	}
});

describe("OAuthFlow", () => {
	it("stores the auth flow in auth_sessions with generic state_json", async () => {
		const { config, dbOps } = createTestContext();
		const oauthFlow = await createOAuthFlow(dbOps, config);

		const result = await oauthFlow.begin({
			name: "claude-code-session-account",
			provider: "claude-code",
		});

		const row = dbOps.getAuthSession(result.sessionId);

		expect(row).toEqual(
			expect.objectContaining({
				provider: "claude-code",
				authMethod: "oauth",
				accountName: "claude-code-session-account",
			}),
		);
		expect(JSON.parse(row?.stateJson ?? "{}")).toEqual(
			expect.objectContaining({
				verifier: result.pkce.verifier,
				state: result.pkce.verifier,
				status: "pending",
			}),
		);
	});

	it("starts a Claude Code OAuth flow with the hosted callback redirect URI", async () => {
		const { config, dbOps } = createTestContext();
		const oauthFlow = await createOAuthFlow(dbOps, config);

		const result = await oauthFlow.begin({
			name: "claude-code-oauth-account",
			provider: "claude-code",
		});

		const authUrl = new URL(result.authUrl);
		expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
			"https://claude.ai/oauth/authorize",
		);
		expect(authUrl.searchParams.get("redirect_uri")).toBe(
			"https://platform.claude.com/oauth/code/callback",
		);
		expect(authUrl.searchParams.get("state")).toBe(result.pkce.verifier);
		expect(authUrl.searchParams.get("scope")).toContain(
			"user:sessions:claude_code",
		);
	});

	it("starts a Codex OAuth flow with the expected auth URL and auth session", async () => {
		const { config, dbOps } = createTestContext();
		const oauthFlow = await createOAuthFlow(dbOps, config);

		const result = await oauthFlow.begin({
			name: "codex-oauth-account",
			provider: "codex",
		});

		const authUrl = new URL(result.authUrl);
		expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
			"https://auth.openai.com/oauth/authorize",
		);
		expect(authUrl.searchParams.get("client_id")).toBe(
			"app_EMoamEEZ73f0CkXaXp7hrann",
		);
		expect(authUrl.searchParams.get("scope")).toBe(
			"openid profile email offline_access",
		);
		expect(authUrl.searchParams.get("codex_cli_simplified_flow")).toBe("true");
		expect(authUrl.searchParams.get("originator")).toBe("codex_cli_rs");

		expect(dbOps.getAuthSession(result.sessionId)).toEqual(
			expect.objectContaining({
				provider: "codex",
				authMethod: "oauth",
				accountName: "codex-oauth-account",
			}),
		);
		expect(
			JSON.parse(dbOps.getAuthSession(result.sessionId)?.stateJson ?? "{}"),
		).toEqual(
			expect.objectContaining({
				verifier: result.pkce.verifier,
				state: result.pkce.verifier,
				status: "pending",
			}),
		);
	});

	it("completes a Codex OAuth flow and stores OAuth tokens on the account", async () => {
		const { config, dbOps } = createTestContext();
		const oauthFlow = await createOAuthFlow(dbOps, config);
		const flowResult = await oauthFlow.begin({
			name: "codex-complete-account",
			provider: "codex",
		});

		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				expect(request.url).toBe("https://auth.openai.com/oauth/token");
				expect(await request.text()).toContain(
					"client_id=app_EMoamEEZ73f0CkXaXp7hrann",
				);

				return new Response(
					JSON.stringify({
						access_token: "openai-access-token",
						refresh_token: "openai-refresh-token",
						expires_in: 3600,
						id_token: unsignedJwt({
							"https://api.openai.com/auth": {
								chatgpt_account_id: "codex-workspace-account",
							},
						}),
					}),
					{
						status: 200,
						headers: {
							"content-type": "application/json",
						},
					},
				);
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const createdAccount = await oauthFlow.complete({
			sessionId: flowResult.sessionId,
			code: "codex-auth-code",
		});

		expect(createdAccount).toEqual({
			id: expect.any(String),
			name: "codex-complete-account",
			provider: "codex",
			authType: "oauth",
		});

		expect(dbOps.getAccount(createdAccount.id)).toEqual(
			expect.objectContaining({
				id: createdAccount.id,
				name: "codex-complete-account",
				provider: "codex",
				auth_method: "oauth",
				api_key: null,
				access_token: "openai-access-token",
				refresh_token: "openai-refresh-token",
				account_uuid: "codex-workspace-account",
				expires_at: expect.any(Number),
			}),
		);
		expect(dbOps.getAuthSession(flowResult.sessionId)).toEqual(
			expect.objectContaining({
				id: flowResult.sessionId,
			}),
		);
		expect(
			JSON.parse(dbOps.getAuthSession(flowResult.sessionId)?.stateJson ?? "{}"),
		).toEqual(
			expect.objectContaining({
				status: "completed",
				state: flowResult.pkce.verifier,
			}),
		);
	});

	it("refuses a Codex browser OAuth workspace outside the enabled allowlist", async () => {
		const { config, dbOps } = createTestContext({
			team_routing: {
				enabled: true,
				allowlisted_account_uuids: ["allowlisted-codex-workspace"],
			},
		});
		const oauthFlow = await createOAuthFlow(dbOps, config);
		const flowResult = await oauthFlow.begin({
			name: "protected-codex-workspace",
			provider: "codex",
		});

		globalThis.fetch = Object.assign(
			async () =>
				Response.json({
					access_token: "protected-codex-access-token",
					refresh_token: "protected-codex-refresh-token",
					expires_in: 3600,
					id_token: unsignedJwt({
						"https://api.openai.com/auth": {
							chatgpt_account_id: "protected-codex-workspace",
						},
					}),
				}),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		await expect(
			oauthFlow.complete({ sessionId: flowResult.sessionId, code: "code" }),
		).rejects.toThrow("not on the configured allowlist");
		expect(dbOps.getAccountByName("protected-codex-workspace")).toBeNull();
	});

	it("allows an explicitly local pool enrollment to create its verified Codex seat", async () => {
		const { config, dbOps } = createTestContext({
			team_routing: {
				enabled: true,
				allowlisted_account_uuids: ["existing-seat"],
			},
		});
		const oauthFlow = await createOAuthFlow(dbOps, config);
		const flowResult = await oauthFlow.begin({
			name: "new-local-codex-seat",
			provider: "codex",
		});

		globalThis.fetch = Object.assign(
			async () =>
				Response.json({
					access_token: "codex-access-token",
					refresh_token: "codex-refresh-token",
					expires_in: 3600,
					id_token: unsignedJwt({
						"https://api.openai.com/auth": {
							chatgpt_account_id: "new-local-codex-seat",
						},
					}),
				}),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const created = await oauthFlow.complete({
			sessionId: flowResult.sessionId,
			code: "code",
			allowUnlistedSeat: true,
		});

		expect(dbOps.getAccount(created.id)).toEqual(
			expect.objectContaining({ account_uuid: "new-local-codex-seat" }),
		);
	});

	it("stores Claude Code account identity from the OAuth profile", async () => {
		const { config, dbOps } = createTestContext();
		const oauthFlow = await createOAuthFlow(dbOps, config);
		const flowResult = await oauthFlow.begin({
			name: "claude-profile-account",
			provider: "claude-code",
		});

		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "https://platform.claude.com/v1/oauth/token") {
					return Response.json({
						access_token: "claude-access-token",
						refresh_token: "claude-refresh-token",
						expires_in: 3600,
					});
				}
				expect(url).toBe("https://api.anthropic.com/api/oauth/profile");
				return Response.json({
					account: { uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
					organization: { uuid: "11111111-2222-3333-4444-555555555555" },
				});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const created = await oauthFlow.complete({
			sessionId: flowResult.sessionId,
			code: "claude-auth-code",
		});

		expect(dbOps.getAccount(created.id)).toEqual(
			expect.objectContaining({
				account_uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				organization_uuid: "11111111-2222-3333-4444-555555555555",
			}),
		);
	});

	it("refuses a Claude Code OAuth identity outside the enabled seat allowlist", async () => {
		const { config, dbOps } = createTestContext({
			team_routing: {
				enabled: true,
				allowlisted_account_uuids: ["allowed-account"],
			},
		});
		const oauthFlow = await createOAuthFlow(dbOps, config);
		const flowResult = await oauthFlow.begin({
			name: "protected-seat",
			provider: "claude-code",
		});

		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "https://platform.claude.com/v1/oauth/token") {
					return Response.json({ access_token: "access", expires_in: 3600 });
				}
				return Response.json({
					account: { uuid: "protected-account" },
					organization: { uuid: "org" },
				});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		await expect(
			oauthFlow.complete({ sessionId: flowResult.sessionId, code: "code" }),
		).rejects.toThrow("not on the configured allowlist");
		expect(dbOps.getAccountByName("protected-seat")).toBeNull();
	});
});
