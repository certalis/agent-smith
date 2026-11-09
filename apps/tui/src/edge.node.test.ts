import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

it("the Node edge streams, cancels upstream, and refuses non-inference routes", async () => {
	const root = mkdtempSync("/tmp/smith-edge-node-");
	try {
		const build = await Bun.build({
			entrypoints: [join(import.meta.dir, "edge.ts")],
			outdir: root,
			naming: "edge.mjs",
			target: "node",
		});
		expect(build.success).toBe(true);
		const script = `
			import assert from "node:assert/strict";
			import { once } from "node:events";
			import { createServer, request } from "node:http";
			import { createProxyEdgeHandler } from ${JSON.stringify(pathToFileURL(join(root, "edge.mjs")).href)};
			const socketPath = ${JSON.stringify(join(root, "pool.sock"))};
			const servers = [];
			let attempts = 0;
			let resolveClosed;
			const upstreamClosed = new Promise(resolve => { resolveClosed = resolve; });
			let upstreamResponse;
			const upstream = createServer((req, res) => {
				attempts++;
				upstreamResponse = res;
				res.once("close", resolveClosed);
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write("data: first\\n\\n");
			});
			async function listen(server, address) {
				servers.push(server);
				server.listen(address);
				await once(server, "listening");
				return server.address();
			}
			function call(port, method, path) {
				return new Promise((resolve, reject) => {
					const req = request({ hostname: "127.0.0.1", port, method, path, agent: false,
						headers: { host: "pool.example", "x-api-key": "synthetic-device" }
					}, resolve);
					req.once("error", reject);
					req.end();
				});
			}
			async function status(port, method, path) {
				const res = await call(port, method, path);
				res.resume();
				await once(res, "end");
				return res.statusCode;
			}
			try {
				await listen(upstream, socketPath);
				const edge = createServer(createProxyEdgeHandler({ origin: "https://pool.example", socketPath }));
				const { port } = await listen(edge, { host: "127.0.0.1", port: 0 });
				assert.equal(await status(port, "GET", "/v1/claude-code/v1/messages"), 404);
				assert.equal(await status(port, "GET", "/api/accounts"), 404);
				assert.equal(attempts, 0);
				const response = await call(port, "POST", "/v1/claude-code/v1/messages");
				const [chunk] = await once(response, "data");
				assert.equal(response.statusCode, 200);
				assert.equal(chunk.toString(), "data: first\\n\\n");
				assert.equal(upstreamResponse.writableEnded, false);
				response.destroy();
				await upstreamClosed;
				assert.equal(upstreamResponse.destroyed, true);
				assert.equal(attempts, 1);
				const missing = createServer(createProxyEdgeHandler({
					origin: "https://pool.example", socketPath: socketPath + ".missing"
				}));
				const missingAddress = await listen(missing, { host: "127.0.0.1", port: 0 });
				assert.equal(await status(missingAddress.port, "POST", "/v1/claude-code/v1/messages"), 502);
				assert.equal(attempts, 1);
				console.log("NODE_EDGE_PASS");
			} finally {
				await Promise.all(servers.map(server => {
					server.closeAllConnections();
					return new Promise(resolve => server.close(resolve));
				}));
			}
		`;
		const child = Bun.spawn(["node", "--input-type=module", "-e", script], {
			env: { PATH: process.env.PATH, HOME: process.env.HOME },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
			expect(stdout).toContain("NODE_EDGE_PASS");
		} finally {
			child.kill();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
