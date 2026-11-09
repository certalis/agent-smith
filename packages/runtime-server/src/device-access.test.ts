import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProxyContext } from "@ccflare/proxy";
import { deviceKeyMatches } from "./device-keys";
import { createServerFetchHandler } from "./fetch-handler";
import { createProxyEdgeHandler } from "./proxy-edge";

const DEVICE_KEY = "synthetic-device-key-0000000000000001";
const OTHER_KEY = "synthetic-device-key-0000000000000002";
const digest = (key: string) => createHash("sha256").update(key).digest("hex");
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function registry() {
	const dir = mkdtempSync(join(tmpdir(), "smith-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "clients.json");
	writeFileSync(
		path,
		JSON.stringify({ laptop: digest(DEVICE_KEY), server: digest(OTHER_KEY) }),
		{ mode: 0o600 },
	);
	return { dir, path };
}

test("device registry reloads revocation and fails closed for invalid or loose files", () => {
	const { path } = registry();
	expect(deviceKeyMatches(DEVICE_KEY, path)).toBe(true);
	expect(deviceKeyMatches("not-a-valid-device-key", path)).toBe(false);
	writeFileSync(path, JSON.stringify({ server: digest(OTHER_KEY) }));
	expect(deviceKeyMatches(DEVICE_KEY, path)).toBe(false);
	expect(deviceKeyMatches(OTHER_KEY, path)).toBe(true);
	chmodSync(path, 0o644);
	expect(deviceKeyMatches(OTHER_KEY, path)).toBe(false);
	chmodSync(path, 0o600);
	writeFileSync(path, "invalid");
	expect(deviceKeyMatches(OTHER_KEY, path)).toBe(false);
	unlinkSync(path);
	expect(deviceKeyMatches(OTHER_KEY, path)).toBe(false);
});

async function fixture(maxBodyBytes = 1024) {
	const { dir, path } = registry();
	const socketPath = join(dir, "control.sock");
	const received: Array<{ path: string; body: string; headers: Headers }> = [];
	const fetchHandler = createServerFetchHandler({
		apiRouter: {
			handleRequest: async (url) =>
				url.pathname === "/health" ? Response.json({ status: "ok" }) : null,
		},
		proxyContext: {} as ProxyContext,
		withDashboard: false,
		exposureConfig: {
			bindHost: "127.0.0.1",
			trustLoopback: false,
			clientKeysFile: path,
		},
		handleProxyRequest: async (req, url) => {
			received.push({
				path: url.pathname + url.search,
				body: await req.text(),
				headers: req.headers,
			});
			return new Response("data: first\n\ndata: [DONE]\n\n", {
				headers: {
					"content-type": "text/event-stream",
					"set-cookie": "must-not-leak",
					"x-api-key": "must-not-leak",
				},
			});
		},
	});
	const pool = Bun.serve({
		unix: socketPath,
		fetch: (req) =>
			fetchHandler(req).then(
				(response) => response ?? new Response(null, { status: 500 }),
			),
	});
	cleanups.push(() => pool.stop(true));
	const edge = createServer(
		createProxyEdgeHandler({
			origin: "https://pool.example.test",
			socketPath,
			maxBodyBytes,
		}),
	);
	await new Promise<void>((resolve) => edge.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => {
		edge.closeAllConnections();
		edge.close();
	});
	const address = edge.address();
	if (!address || typeof address === "string")
		throw new Error("Missing test listener");
	const call = (
		route: string,
		key = DEVICE_KEY,
		method = "POST",
		body = "{}",
		extra: Record<string, string> = {},
	) =>
		new Promise<{
			status: number;
			body: string;
			headers: import("node:http").IncomingHttpHeaders;
		}>((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: address.port,
					path: route,
					method,
					agent: false,
					headers: {
						host: "pool.example.test",
						...(key ? { "x-api-key": key } : {}),
						...extra,
					},
				},
				(res) => {
					let result = "";
					res.on("data", (chunk) => {
						result += chunk;
					});
					res.once("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							body: result,
							headers: res.headers,
						}),
					);
					res.once("error", reject);
				},
			);
			req.once("error", reject);
			req.end(method === "GET" ? undefined : body);
		});
	return { call, received, path, fetchHandler };
}

test("HTTPS edge streams the exact Messages body and only allowed headers through the private socket", async () => {
	const { call, received } = await fixture();
	const body = '{ "model": "synthetic-model", "messages": [] }';
	const result = await call(
		"/v1/claude-code/v1/messages?beta=true",
		DEVICE_KEY,
		"POST",
		body,
		{
			cookie: "secret",
			"x-forwarded-for": "spoofed",
			"anthropic-beta": "synthetic-beta",
		},
	);
	expect(result.status).toBe(200);
	expect(result.body).toBe("data: first\n\ndata: [DONE]\n\n");
	expect(result.headers["set-cookie"]).toBeUndefined();
	expect(result.headers["x-api-key"]).toBeUndefined();
	expect(received[0].body).toBe(body);
	expect(received[0].path).toBe("/v1/claude-code/v1/messages?beta=true");
	expect(received[0].headers.get("cookie")).toBeNull();
	expect(received[0].headers.get("x-forwarded-for")).toBe("proxy-edge");
	expect(received[0].headers.get("anthropic-beta")).toBe("synthetic-beta");
});

test("health and Responses accept device keys; unknown and revoked keys cannot reach the pool", async () => {
	const { call, received, path } = await fixture();
	expect((await call("/pool-health", DEVICE_KEY, "GET")).status).toBe(200);
	expect(
		(
			await call("/v1/pool/openai-responses/responses", "", "POST", "{}", {
				authorization: `Bearer ${OTHER_KEY}`,
				"session-id": "synthetic-codex-session",
			})
		).status,
	).toBe(200);
	expect(
		(
			await call(
				"/v1/claude-code/v1/messages",
				"unknown-secret-0000000000000000000000",
			)
		).status,
	).toBe(401);
	expect((await call("/v1/claude-code/v1/messages", "")).status).toBe(401);
	writeFileSync(path, JSON.stringify({ server: digest(OTHER_KEY) }));
	expect((await call("/v1/claude-code/v1/messages")).status).toBe(401);
	expect(received).toHaveLength(1);
	expect(received[0].headers.get("session-id")).toBe("synthetic-codex-session");
});

test("edge refuses management, OAuth, traversal, wrong origins and oversized bodies before forwarding", async () => {
	const { call, received, fetchHandler } = await fixture(32);
	for (const route of [
		"/api/accounts",
		"/oauth/callback",
		"/v1/oauth/token",
		"/",
		"/v1/claude-code/v1/messages?x=1",
		"/v1/claude-code/v1/../messages",
		"/v1/claude-code/v1/%2e%2e/messages",
	]) {
		expect((await call(route)).status).toBe(404);
	}
	expect(
		(
			await call("/v1/claude-code/v1/messages", DEVICE_KEY, "POST", "{}", {
				host: "evil.example",
			})
		).status,
	).toBe(403);
	expect(
		(
			await call("/v1/claude-code/v1/messages", DEVICE_KEY, "POST", "{}", {
				origin: "https://evil.example",
			})
		).status,
	).toBe(403);
	expect(
		(
			await call(
				"/v1/claude-code/v1/messages",
				DEVICE_KEY,
				"POST",
				"x".repeat(33),
			)
		).status,
	).toBe(413);
	expect(received).toHaveLength(0);
	const management = await fetchHandler(
		new Request("http://localhost/api/accounts", {
			headers: { "x-api-key": DEVICE_KEY },
		}),
	);
	expect(management?.status).toBe(403);
});
