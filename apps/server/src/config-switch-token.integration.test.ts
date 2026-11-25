import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteConfigFile } from "@agent-smith/config/rewrite-config-cli";
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
