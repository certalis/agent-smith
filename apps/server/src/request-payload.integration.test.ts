import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { join } from "node:path";
import { startFakeUpstream } from "./scenarios/harness/fake-upstream";
import { seedFleet } from "./scenarios/harness/fleet";
import { spawnServer } from "./scenarios/harness/spawn-server";

it("stores chooser headers while removing them from the upstream request", async () => {
	const chooserHeaders = {
		"x-agent-smith-interactive-provider-choice": "v1",
		"x-agent-smith-provider-choice": "claude-code",
		"x-agent-smith-provider-menu": "v1",
		"x-agent-smith-provider-wait": "v1",
		"x-agent-smith-provider-promotion-declined": "v1",
	};
	const upstream = startFakeUpstream({
		rules: [
			{
				account: "seat",
				path: "/v1/messages",
				status: 200,
				json: {
					id: "msg_fake",
					type: "message",
					role: "assistant",
					content: [],
					model: "claude-sonnet-4-5",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			},
		],
		tokenToAccount: new Map([["tok-seat", "seat"]]),
	});
	let server: Awaited<ReturnType<typeof spawnServer>> | undefined;
	let db: Database | undefined;
	try {
		if (new URL(upstream.url).port === "18081")
			throw new Error("forbidden port");
		server = await spawnServer({
			config: {
				providers: { "claude-code": { enabled: true } },
				data_retention_days: 7,
			},
			seed: ({ dbPath }) =>
				seedFleet({
					dbPath,
					defaultBaseUrl: upstream.url,
					accounts: [{ name: "seat", provider: "claude-code" }],
				}),
		});
		if (new URL(server.url).port === "18081") throw new Error("forbidden port");
		const response = await fetch(`${server.url}/v1/claude-code/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...chooserHeaders,
				"x-api-key": "private-client-key",
			},
			body: '{"model":"claude-sonnet-4-5","messages":[]}',
		});
		expect(response.status).toBe(200);
		await response.text();
		db = new Database(join(server.workspace, "agent-smith.db"), {
			readonly: true,
		});
		let stored: { json: string } | null = null;
		const deadline = Date.now() + 5_000;
		while (!stored && Date.now() < deadline) {
			stored = db.query("SELECT json FROM request_payloads LIMIT 1").get() as {
				json: string;
			} | null;
			if (!stored) await Bun.sleep(20);
		}
		if (!stored) throw new Error("request payload was not stored");
		const payload = JSON.parse(stored.json) as {
			request: { headers: Record<string, string> };
		};
		expect(payload.request.headers).toMatchObject(chooserHeaders);
		expect(payload.request.headers["x-api-key"]).toBeUndefined();
		expect(upstream.requests).toHaveLength(1);
		for (const name of Object.keys(chooserHeaders))
			expect(upstream.requests[0]?.headers.has(name)).toBe(false);
	} finally {
		db?.close();
		if (server) await server.stop();
		await upstream.stop();
	}
}, 15_000);
