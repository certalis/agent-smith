import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	credentialsFromCodexTokenResponse,
	importCodexCredentials,
} from "./credentials";

const tempDirs: string[] = [];

function unsignedJwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function writeNativeAuthFile(contents: unknown): string {
	const home = mkdtempSync(join(tmpdir(), "ccflare-codex-auth-"));
	tempDirs.push(home);
	const codexDirectory = join(home, ".codex");
	mkdirSync(codexDirectory);
	writeFileSync(join(codexDirectory, "auth.json"), JSON.stringify(contents));
	return home;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { force: true, recursive: true });
	}
});

describe("Codex credentials", () => {
	it("imports native credentials and prefers the signed workspace identity", async () => {
		const home = writeNativeAuthFile({
			tokens: {
				access_token: "codex-access-token",
				refresh_token: "codex-refresh-token",
				account_id: "stored-account",
				id_token: unsignedJwt({
					email: "operator@example.test",
					"https://api.openai.com/auth": {
						chatgpt_account_id: "signed-workspace",
						chatgpt_plan_type: "pro",
					},
				}),
			},
		});

		await expect(
			importCodexCredentials("~/.codex/auth.json", { home }),
		).resolves.toEqual({
			accessToken: "codex-access-token",
			refreshToken: "codex-refresh-token",
			accountId: "signed-workspace",
			email: "operator@example.test",
			planType: "pro",
		});
	});

	it("falls back to the stored account id when no signed identity exists", async () => {
		const home = writeNativeAuthFile({
			tokens: {
				access_token: "codex-access-token",
				refresh_token: "codex-refresh-token",
				account_id: "stored-account",
			},
		});

		await expect(
			importCodexCredentials("~/.codex/auth.json", { home }),
		).resolves.toEqual({
			accessToken: "codex-access-token",
			refreshToken: "codex-refresh-token",
			accountId: "stored-account",
		});
	});

	it("keeps native credentials usable when optional JWT identity is malformed", async () => {
		const home = writeNativeAuthFile({
			tokens: {
				access_token: "codex-access-token",
				refresh_token: "codex-refresh-token",
				account_id: "stored-account",
				id_token: "not-a-jwt",
			},
		});

		await expect(
			importCodexCredentials("~/.codex/auth.json", { home }),
		).resolves.toEqual({
			accessToken: "codex-access-token",
			refreshToken: "codex-refresh-token",
			accountId: "stored-account",
		});
	});

	it("returns no usable access token when the native file has no token payload", async () => {
		const home = writeNativeAuthFile({});

		await expect(
			importCodexCredentials("~/.codex/auth.json", { home }),
		).resolves.toEqual({});
	});

	it("normalizes token exchange credentials with the same workspace identity", () => {
		expect(
			credentialsFromCodexTokenResponse({
				access_token: "codex-access-token",
				refresh_token: "codex-refresh-token",
				id_token: unsignedJwt({
					email: "operator@example.test",
					"https://api.openai.com/auth": {
						chatgpt_account_id: "signed-workspace",
						chatgpt_plan_type: "pro",
					},
				}),
			}),
		).toEqual({
			accessToken: "codex-access-token",
			refreshToken: "codex-refresh-token",
			accountId: "signed-workspace",
			email: "operator@example.test",
			planType: "pro",
		});
	});
});
