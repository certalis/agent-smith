import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSchema, runMigrations } from "../migrations";
import { AccountRepository } from "./account.repository";

describe("AccountRepository", () => {
	let db: Database;
	let repository: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repository = new AccountRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	it("creates API key accounts and supports lookup/count queries", () => {
		const created = repository.create({
			name: "primary-anthropic",
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "sk-ant-test",
			base_url: "https://anthropic.internal",
		});

		expect(created).toEqual(
			expect.objectContaining({
				id: expect.any(String),
				name: "primary-anthropic",
				provider: "anthropic",
				auth_method: "api_key",
				api_key: "sk-ant-test",
				base_url: "https://anthropic.internal",
				weight: 1,
				request_count: 0,
				total_requests: 0,
				paused: false,
			}),
		);
		expect(repository.count()).toBe(1);
		expect(repository.findById(created.id)).toEqual(created);
		expect(repository.findByName("primary-anthropic")).toEqual(created);
	});

	it("creates OAuth accounts and filters them by provider", () => {
		repository.create({
			name: "codex-main",
			provider: "codex",
			auth_method: "oauth",
			access_token: "codex-access-token",
			refresh_token: "codex-refresh-token",
			expires_at: 123_456,
		});
		repository.create({
			name: "openai-main",
			provider: "openai",
			auth_method: "api_key",
			api_key: "sk-openai-test",
		});

		const providerAccounts = repository.findByProvider("codex");

		expect(providerAccounts).toHaveLength(1);
		expect(providerAccounts[0]).toEqual(
			expect.objectContaining({
				name: "codex-main",
				provider: "codex",
				auth_method: "oauth",
				access_token: "codex-access-token",
				refresh_token: "codex-refresh-token",
				expires_at: 123_456,
			}),
		);
	});

	it("persists structured quota state with an OAuth account", () => {
		const quotaState = {
			windows: {
				unified5h: {
					resetAt: 1_700_000_360_000,
					seenAt: 1_700_000_000_000,
					status: "allowed",
					utilization: 0.42,
				},
			},
		};
		const created = repository.createOAuthAccount({
			name: "claude-code-main",
			provider: "claude-code",
			accessToken: "access",
			quotaState,
		});

		expect(repository.findById(created.id)?.quota_state).toEqual(quotaState);
	});

	it("restores structured quota state after reopening a file-backed database", () => {
		const tempDir = mkdtempSync(
			join(tmpdir(), "agent-smith-account-repository-"),
		);
		const databasePath = join(tempDir, "agent-smith.db");
		const quotaState = {
			windows: {
				unified7d: {
					resetAt: 1_700_000_360_000,
					seenAt: 1_700_000_000_000,
					status: "rejected" as const,
					utilization: null,
				},
			},
		};
		let first: Database | undefined;
		let reopened: Database | undefined;

		try {
			first = new Database(databasePath);
			ensureSchema(first);
			runMigrations(first);
			const created = new AccountRepository(first).createOAuthAccount({
				name: "restart-safe-pool-account",
				provider: "claude-code",
				accessToken: "access",
				quotaState,
			});
			first.close();
			first = undefined;

			reopened = new Database(databasePath);
			ensureSchema(reopened);
			runMigrations(reopened);
			expect(
				new AccountRepository(reopened).findById(created.id)?.quota_state,
			).toEqual(quotaState);
		} finally {
			first?.close();
			reopened?.close();
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("persists and clears an account-specific quota threshold", () => {
		const created = repository.create({
			name: "account-threshold",
			provider: "claude-code",
			auth_method: "oauth",
			access_token: "access",
			switch_threshold: { default: 0.9, unified7dFable: 0.8 },
		});

		expect(repository.findById(created.id)?.switch_threshold).toEqual({
			default: 0.9,
			unified7dFable: 0.8,
		});
		expect(
			repository.update(created.id, { switch_threshold: null })
				?.switch_threshold,
		).toBeNull();
	});

	it("persists an account error and clears it when the account resumes", () => {
		const created = repository.create({
			name: "expired-grant",
			provider: "claude-code",
			auth_method: "oauth",
			access_token: "access",
		});

		repository.markError(
			created.id,
			"OAuth refresh was rejected by the upstream",
		);
		expect(repository.findById(created.id)).toEqual(
			expect.objectContaining({
				paused: true,
				error_reason: "OAuth refresh was rejected by the upstream",
			}),
		);

		repository.resume(created.id);
		expect(repository.findById(created.id)).toEqual(
			expect.objectContaining({ paused: false, error_reason: null }),
		);
	});

	it("updates existing accounts and returns the updated row", () => {
		const created = repository.create({
			name: "rename-me",
			provider: "openai",
			auth_method: "api_key",
			api_key: "sk-openai-test",
		});

		const updated = repository.update(created.id, {
			name: "renamed-account",
			base_url: "https://custom.endpoint/v1",
		});

		expect(updated).toEqual(
			expect.objectContaining({
				id: created.id,
				name: "renamed-account",
				base_url: "https://custom.endpoint/v1",
				api_key: "sk-openai-test",
			}),
		);
		expect(repository.findByName("rename-me")).toBeNull();
		expect(repository.findByName("renamed-account")).toEqual(updated);
	});

	it("deletes accounts by id and reports whether anything changed", () => {
		const created = repository.create({
			name: "delete-me",
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "sk-ant-test",
		});

		expect(repository.delete(created.id)).toBe(true);
		expect(repository.findById(created.id)).toBeNull();
		expect(repository.count()).toBe(0);
		expect(repository.delete(created.id)).toBe(false);
	});

	it("rejects duplicate account names", () => {
		repository.create({
			name: "duplicate-name",
			provider: "anthropic",
			auth_method: "api_key",
			api_key: "sk-ant-test",
		});

		expect(() =>
			repository.create({
				name: "duplicate-name",
				provider: "openai",
				auth_method: "api_key",
				api_key: "sk-openai-test",
			}),
		).toThrow(/accounts\.name|UNIQUE constraint failed/);
	});
});
