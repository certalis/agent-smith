import { expect, it } from "bun:test";
import { join } from "node:path";

(process.platform === "linux" ? it : it.skip)(
	"serves one private runtime on loopback and a second configured address",
	async () => {
		const script = `
		import assert from "node:assert/strict";
		import { mkdtempSync, rmSync } from "node:fs";
		import { join } from "node:path";
		import startServer from "./apps/server/src/server.ts";
		const root = mkdtempSync("/tmp/smith-multi-bind-");
		let server;
		try {
			Object.assign(process.env, {
				ccflare_DB_PATH: join(root, "pool.db"),
				ccflare_CONFIG_PATH: join(root, "config.json"),
				CF_BIND_HOSTS: "127.0.0.1,127.0.0.2",
				CF_TRUST_LOOPBACK: "false",
				CF_PROXY_KEY: "synthetic-proxy"
			});
			server = startServer({ port: 0, withDashboard: false });
			for (const host of ["127.0.0.1", "127.0.0.2"]) {
				const response = await fetch("http://" + host + ":" + server.port + "/health", {
					headers: { "x-api-key": "synthetic-proxy" },
					signal: AbortSignal.timeout(500)
				});
				assert.equal(response.status, 200);
			}
			await server.stop();
			await assert.rejects(fetch("http://127.0.0.1:" + server.port + "/health"));
			await assert.rejects(fetch("http://127.0.0.2:" + server.port + "/health"));
			console.log("MULTI_BIND_PASS");
		} finally {
			await server?.stop();
			rmSync(root, { recursive: true, force: true });
		}
	`;
		const child = Bun.spawn(["bun", "-e", script], {
			cwd: join(import.meta.dir, "../../.."),
			env: { PATH: process.env.PATH, HOME: process.env.HOME },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		expect(stdout).toContain("MULTI_BIND_PASS");
	},
);

(process.platform === "linux" ? it : it.skip)(
	"closes an earlier extra listener when a later address is unavailable",
	async () => {
		const script = `
		import assert from "node:assert/strict";
		import { mkdtempSync, rmSync } from "node:fs";
		import { join } from "node:path";
		import startServer from "./apps/server/src/server.ts";
		const root = mkdtempSync("/tmp/smith-multi-bind-");
		const blocker = Bun.serve({ hostname: "127.0.0.3", port: 0, fetch: () => new Response("busy") });
		const port = blocker.port;
		if (port === undefined) throw new Error("Expected the blocker to report its port");
		try {
			Object.assign(process.env, {
				ccflare_DB_PATH: join(root, "pool.db"),
				ccflare_CONFIG_PATH: join(root, "config.json"),
				CF_BIND_HOSTS: "127.0.0.1,127.0.0.2,127.0.0.3",
				CF_TRUST_LOOPBACK: "false",
				CF_PROXY_KEY: "synthetic-proxy"
			});
			assert.throws(() => startServer({ port, withDashboard: false }));
			await assert.rejects(fetch("http://127.0.0.2:" + port + "/health", {
				headers: { "x-api-key": "synthetic-proxy" },
				signal: AbortSignal.timeout(500)
			}));
			console.log("MULTI_BIND_CLEANUP_PASS");
		} finally {
			await blocker.stop(true);
			rmSync(root, { recursive: true, force: true });
		}
	`;
		const child = Bun.spawn(["bun", "-e", script], {
			cwd: join(import.meta.dir, "../../.."),
			env: { PATH: process.env.PATH, HOME: process.env.HOME },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		expect(stdout).toContain("MULTI_BIND_CLEANUP_PASS");
	},
);

it("stops and restarts both listeners and cleans up after a partial bind failure", async () => {
	const script = `
		import assert from "node:assert/strict";
		import { mkdtempSync, rmSync } from "node:fs";
		import { join } from "node:path";
		import startServer from "./apps/server/src/server.ts";
		const root = mkdtempSync("/tmp/smith-private-");
		const socket = join(root, "control.sock");
		Object.assign(process.env, {
			ccflare_DB_PATH: join(root, "pool.db"),
			ccflare_CONFIG_PATH: join(root, "config.json"),
			CF_HOST: "127.0.0.1", CF_TRUST_LOOPBACK: "false",
			CF_ADMIN_KEY: "synthetic-admin", CF_PROXY_KEY: "synthetic-proxy"
		});
		let server;
		try {
			server = startServer({ port: 0, withDashboard: false, additionalUnixSocket: socket });
			const local = "http://127.0.0.1:" + server.port;
			await server.stop();
			await assert.rejects(fetch(local + "/health", { unix: socket }));
			await assert.rejects(fetch(local + "/health"));
			server = startServer({ port: 0, withDashboard: false, additionalUnixSocket: socket });
			const restarted = await fetch("http://127.0.0.1/api/accounts", {
				unix: socket, headers: { "x-api-key": "synthetic-admin" }
			});
			assert.equal(restarted.status, 200);
			assert.deepEqual(await restarted.json(), []);
			await server.stop();
			const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
			try {
				assert.throws(() => startServer({ port: occupied.port, withDashboard: false, additionalUnixSocket: socket }));
				await assert.rejects(fetch("http://127.0.0.1/health", { unix: socket }));
			} finally { await occupied.stop(true); }
			console.log("PRIVATE_SOCKET_PASS");
		} finally {
			await server?.stop();
			rmSync(root, { recursive: true, force: true });
		}
	`;
	const child = Bun.spawn(["bun", "-e", script], {
		cwd: join(import.meta.dir, "../../.."),
		env: { PATH: process.env.PATH, HOME: process.env.HOME },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
	expect(stdout).toContain("PRIVATE_SOCKET_PASS");
});
