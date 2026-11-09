import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnServer, withoutProxyEnvironment } from "./spawn-server";

const proxyVariables = [
	"ALL_PROXY",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"NO_PROXY",
	"all_proxy",
	"https_proxy",
	"http_proxy",
	"no_proxy",
] as const;

test("removes proxy variables while the parent scenario harness makes requests", async () => {
	const original = new Map(
		proxyVariables.map((name) => [name, process.env[name]]),
	);
	for (const name of proxyVariables) {
		process.env[name] = "http://example.test:8080";
	}

	try {
		await withoutProxyEnvironment(async () => {
			for (const name of proxyVariables) {
				expect(process.env[name]).toBeUndefined();
			}
		});
	} finally {
		for (const [name, value] of original) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	}

	for (const [name, value] of original) {
		expect(process.env[name]).toBe(value);
	}
});

test("serializes concurrent parent proxy-free request scopes", async () => {
	const original = process.env.HTTP_PROXY;
	process.env.HTTP_PROXY = "http://example.test:8080";
	let releaseFirst = () => {};
	let markFirstEntered = () => {};
	const firstReleased = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const firstEntered = new Promise<void>((resolve) => {
		markFirstEntered = resolve;
	});

	try {
		const first = withoutProxyEnvironment(async () => {
			expect(process.env.HTTP_PROXY).toBeUndefined();
			markFirstEntered();
			await firstReleased;
		});
		await firstEntered;

		let secondEntered = false;
		const second = withoutProxyEnvironment(async () => {
			secondEntered = true;
			expect(process.env.HTTP_PROXY).toBeUndefined();
		});
		expect(secondEntered).toBeFalse();

		releaseFirst();
		await Promise.all([first, second]);
		expect(process.env.HTTP_PROXY).toBe("http://example.test:8080");
	} finally {
		if (original === undefined) {
			delete process.env.HTTP_PROXY;
		} else {
			process.env.HTTP_PROXY = original;
		}
	}
});

test("starts the real server in its own process and always removes its workspace", async () => {
	const server = await spawnServer({ initialTime: 1_700_000_000_000 });

	try {
		const response = await withoutProxyEnvironment(() =>
			fetch(`${server.url}/health`),
		);
		expect(response.status).toBe(200);
		expect(server.pid).not.toBe(process.pid);
		expect(server.guardedUrls).toEqual([]);
	} finally {
		await server.stop();
	}

	expect(existsSync(server.workspace)).toBeFalse();
	expect(() => process.kill(server.pid, 0)).toThrow();
}, 30_000);

test("authenticates the startup health check with an inherited proxy key", async () => {
	const original = process.env.AGENT_SMITH_PROXY_KEY;
	process.env.AGENT_SMITH_PROXY_KEY = "scenario-inherited-proxy-key";

	try {
		const server = await spawnServer({
			environment: { AGENT_SMITH_TRUST_LOOPBACK: "false" },
			initialTime: 1_700_000_000_000,
		});
		try {
			const response = await withoutProxyEnvironment(() =>
				fetch(`${server.url}/health`, {
					headers: { "x-api-key": "scenario-inherited-proxy-key" },
				}),
			);
			expect(response.status).toBe(200);
		} finally {
			await server.stop();
		}
	} finally {
		if (original === undefined) {
			delete process.env.AGENT_SMITH_PROXY_KEY;
		} else {
			process.env.AGENT_SMITH_PROXY_KEY = original;
		}
	}
}, 30_000);

test("binds an optional private socket inside the temporary workspace", async () => {
	const server = await spawnServer({
		privateSocket: true,
		environment: {
			AGENT_SMITH_PROXY_KEY: "scenario-private-proxy-key",
			AGENT_SMITH_TRUST_LOOPBACK: "false",
		},
	});
	const socket = join(server.workspace, "control.sock");

	try {
		const response = await withoutProxyEnvironment(() =>
			fetch("http://127.0.0.1/health", {
				unix: socket,
				headers: { "x-api-key": "scenario-private-proxy-key" },
			}),
		);
		expect(response.status).toBe(200);
	} finally {
		await server.stop();
	}

	expect(existsSync(socket)).toBeFalse();
}, 30_000);
