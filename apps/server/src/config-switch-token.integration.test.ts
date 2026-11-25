import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteConfigFile } from "@agent-smith/config";
import { startFakeUpstream } from "./scenarios/harness/fake-upstream";
import { seedFleet } from "./scenarios/harness/fleet";
import { spawnServer } from "./scenarios/harness/spawn-server";

test("a persisted Claude seat serves after rewriting config without rewriting its database", async () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-config-switch-"));
	const configPath = join(directory, "config.json"),
		dbPath = join(directory, "agent-smith.db"),
		oldPath = join(directory, "old.json");
	const upstream = startFakeUpstream({
		rules: [
			{
				account: "seat",
				path: "/v1/messages",
				status: 200,
				json: { ok: true },
			},
		],
		tokenToAccount: new Map([["tok-seat", "seat"]]),
	});
	let server: Awaited<ReturnType<typeof spawnServer>> | undefined;
	try {
		if (new URL(upstream.url).port === "18081")
			throw new Error("forbidden port");
		seedFleet({
			dbPath,
			defaultBaseUrl: upstream.url,
			accounts: [
				{ name: "seat", provider: "claude-code", accountUuid: "seat-uuid" },
			],
		});
		const digest = () =>
			createHash("sha256").update(readFileSync(dbPath)).digest("hex");
		const before = digest();
		writeFileSync(
			oldPath,
			JSON.stringify({
				providers: { "claude-code": { enabled: true } },
				team_routing: {
					enabled: true,
					allowlisted_account_uuids: ["seat-uuid"],
				},
			}),
		);
		rewriteConfigFile(oldPath, configPath);
		expect(digest()).toBe(before);
		server = await spawnServer({
			workspace: { directory, configPath, dbPath },
		});
		if (new URL(server.url).port === "18081") throw new Error("forbidden port");
		const response = await fetch(`${server.url}/v1/claude-code/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"model":"claude-sonnet-4-5","messages":[]}',
		});
		expect(response.status).toBe(200);
		expect(upstream.requests.map((request) => request.account)).toEqual([
			"seat",
		]);
		expect(server.guardedUrls).toEqual([]);
	} finally {
		if (server) await server.stop();
		await upstream.stop();
		rmSync(directory, { recursive: true, force: true });
	}
}, 15_000);

test("a laptop-shaped legacy config is migrated on server startup and serves", async () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-startup-rewrite-"));
	const configPath = join(directory, "config.json");
	const dbPath = join(directory, "agent-smith.db");
	const upstream = startFakeUpstream({
		rules: [
			{
				account: "key-seat",
				path: "/v1/messages",
				status: 200,
				times: 2,
				json: { ok: true },
			},
		],
		tokenToAccount: new Map([["key-key-seat", "key-seat"]]),
	});
	let server: Awaited<ReturnType<typeof spawnServer>> | undefined;
	try {
		if (new URL(upstream.url).port === "18081")
			throw new Error("forbidden port");
		const original = JSON.stringify({
			lb_strategy: "session",
			client_id: "synthetic",
			client: { enabled: false },
			providers: { anthropic: { enabled: true } },
			provider_pools: { "anthropic-messages": ["anthropic"] },
			max_body_bytes: 2048,
			quota_threshold: 0.9,
			retry_attempts: 3,
			retry_delay_ms: 10,
			retry_backoff: 2,
			session_duration_ms: 1000,
		});
		writeFileSync(configPath, original, { mode: 0o600 });
		seedFleet({
			dbPath,
			defaultBaseUrl: upstream.url,
			accounts: [
				{ name: "key-seat", provider: "anthropic", authMethod: "api_key" },
			],
		});
		server = await spawnServer({
			workspace: { directory, configPath, dbPath },
		});
		if (new URL(server.url).port === "18081") throw new Error("forbidden port");
		const send = () =>
			fetch(`${server?.url}/v1/pool/anthropic-messages/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: '{"model":"claude-sonnet-4-5","messages":[]}',
			});
		expect((await send()).status).toBe(200);
		const migrated = readFileSync(configPath, "utf8");
		expect(JSON.parse(migrated)).toHaveProperty("routing");
		expect(readFileSync(`${configPath}.backup`, "utf8")).toBe(original);
		server = await server.restart(Date.now());
		if (new URL(server.url).port === "18081") throw new Error("forbidden port");
		const resumed = await send();
		expect({ status: resumed.status, body: await resumed.text() }).toEqual({
			status: 200,
			body: '{"ok":true}',
		});
		expect(readFileSync(configPath, "utf8")).toBe(migrated);
		expect(readFileSync(`${configPath}.backup`, "utf8")).toBe(original);
		expect(server.guardedUrls).toEqual([]);
	} finally {
		if (server) await server.stop();
		await upstream.stop();
		rmSync(directory, { recursive: true, force: true });
	}
}, 15_000);
