import { expect, test } from "bun:test";
import { startFakeUpstream } from "./fake-upstream";
import { at, type UpstreamRule } from "./scenario";
import { withoutProxyEnvironment } from "./spawn-server";

test("scripts a response and records the raw request sent to an account", async () => {
	const rules: UpstreamRule[] = [
		{
			account: "a",
			path: "/v1/messages",
			status: 200,
			headers: { "x-reset-at": at("1h") },
			json: { ok: true },
		},
	];
	const upstream = startFakeUpstream({
		rules,
		tokenToAccount: new Map([["tok-a", "a"]]),
		now: () => 1_700_000_000_000,
	});

	try {
		const body = '{"messages":["hello"]}';
		const response = await withoutProxyEnvironment(() =>
			fetch(`${upstream.url}/v1/messages`, {
				method: "POST",
				headers: {
					Authorization: "Bearer tok-a",
					"content-type": "application/json",
				},
				body,
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(response.headers.get("x-reset-at")).toBe("1700003600");
		expect(upstream.requests).toHaveLength(1);
		expect(upstream.requests[0]).toMatchObject({
			account: "a",
			method: "POST",
			path: "/v1/messages",
		});
		expect(new TextDecoder().decode(upstream.requests[0]?.body)).toBe(body);
	} finally {
		await upstream.stop();
	}
});

test("reports an unfilled hold by its expected request count", async () => {
	const upstream = startFakeUpstream({
		rules: [
			{
				path: "/v1/messages",
				status: 200,
				json: { ok: true },
				hold: { received: 2, within: "20ms" },
			},
		],
		tokenToAccount: new Map(),
	});

	try {
		void withoutProxyEnvironment(() =>
			fetch(`${upstream.url}/v1/messages`, { method: "POST", body: "one" }),
		);
		await expect(upstream.waitForHolds()).rejects.toThrow(
			"expected 2 requests, received 1",
		);
	} finally {
		await upstream.stop();
	}
});

test("keeps a manually held response pending until the scenario releases it", async () => {
	const upstream = startFakeUpstream({
		rules: [
			{
				id: "first-request",
				path: "/v1/messages",
				status: 200,
				json: { ok: true },
				hold: { received: 1, release: "manual" },
			},
		],
		tokenToAccount: new Map(),
	});

	try {
		const pending = withoutProxyEnvironment(() =>
			fetch(`${upstream.url}/v1/messages`, { method: "POST", body: "one" }),
		);
		await upstream.waitForRequests(1);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		upstream.releaseHold("first-request");
		const response = await pending;
		expect(response.status).toBe(200);
		await upstream.waitForHolds();
	} finally {
		await upstream.stop();
	}
});

test("releases a later SSE chunk only after the client observes the first", async () => {
	const upstream = startFakeUpstream({
		rules: [
			{
				path: "/v1/messages",
				status: 200,
				sse: [
					{ body: "event: first\n\n" },
					{ body: "event: second\n\n", afterClientChunk: true },
				],
			},
		],
		tokenToAccount: new Map(),
	});

	try {
		const response = await withoutProxyEnvironment(() =>
			fetch(`${upstream.url}/v1/messages`, {
				method: "POST",
				headers: { "x-ccflare-scenario-client-id": "sse-client" },
			}),
		);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();

		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toBe("event: first\n\n");

		upstream.releaseAfterClientChunk("sse-client");
		const second = await reader?.read();
		expect(new TextDecoder().decode(second?.value)).toBe("event: second\n\n");
	} finally {
		await upstream.stop();
	}
});
