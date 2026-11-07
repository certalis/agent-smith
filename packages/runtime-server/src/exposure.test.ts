import { describe, expect, test } from "bun:test";
import {
	createExposureConfig,
	type ExposureConfig,
	exposureFailure,
	isForwardedRequest,
	isLocalHostHeader,
} from "./exposure";

const config: ExposureConfig = {
	adminKey: "admin-key",
	bindHost: "127.0.0.1",
	bindHosts: ["127.0.0.1"],
	proxyKey: "proxy-key",
	trustLoopback: true,
};

const loopbackServer = {
	requestIP: () => ({ address: "127.0.0.1" }),
} as unknown as Pick<Bun.Server<unknown>, "requestIP">;

function request(path: string, init: RequestInit = {}): [Request, URL] {
	const url = new URL(`http://127.0.0.1:8080${path}`);
	return [new Request(url, init), url];
}

describe("exposure gate", () => {
	test("treats forwarded loopback requests as non-local", () => {
		const [req, url] = request("/v1/claude-code/v1/messages", {
			headers: { "x-forwarded-for": "203.0.113.7" },
			method: "POST",
		});

		expect(exposureFailure(req, url, loopbackServer, config)?.status).toBe(401);
	});

	test("allows a forwarded request with the configured proxy key", () => {
		const [req, url] = request("/v1/claude-code/v1/messages", {
			headers: {
				"x-api-key": "proxy-key",
				"x-forwarded-for": "203.0.113.7",
			},
			method: "POST",
		});

		expect(exposureFailure(req, url, loopbackServer, config)).toBeNull();
	});

	test("allows a Responses request with the configured bearer proxy key", () => {
		const [req, url] = request("/v1/codex/responses", {
			headers: {
				authorization: "Bearer proxy-key",
				"x-forwarded-for": "203.0.113.7",
			},
			method: "POST",
		});

		expect(exposureFailure(req, url, loopbackServer, config)).toBeNull();
	});

	test("does not accept a bearer proxy key for management", () => {
		const [req, url] = request("/api/status", {
			headers: {
				authorization: "Bearer proxy-key",
				"x-forwarded-for": "203.0.113.7",
			},
		});

		expect(exposureFailure(req, url, loopbackServer, config)?.status).toBe(401);
	});

	test("does not accept a bearer proxy key for OAuth token exchange", () => {
		const [req, url] = request("/v1/oauth/token", {
			headers: {
				authorization: "Bearer proxy-key",
				"x-forwarded-for": "203.0.113.7",
			},
			method: "POST",
		});

		expect(exposureFailure(req, url, loopbackServer, config)?.status).toBe(401);
	});

	test("rejects a cross-origin management write before it can mutate", () => {
		const [req, url] = request("/api/accounts", {
			headers: {
				"x-api-key": "admin-key",
				origin: "https://attacker.example",
			},
			method: "POST",
		});

		expect(exposureFailure(req, url, loopbackServer, config)?.status).toBe(403);
	});

	test("requires the admin key for a management write", () => {
		const [req, url] = request("/api/accounts", {
			headers: { "x-api-key": "proxy-key" },
			method: "POST",
		});

		expect(exposureFailure(req, url, loopbackServer, config)?.status).toBe(401);
	});

	test("does not allow loopback management writes without an admin key", () => {
		const [req, url] = request("/api/accounts", { method: "POST" });
		expect(
			exposureFailure(req, url, loopbackServer, {
				bindHost: "127.0.0.1",
				bindHosts: ["127.0.0.1"],
				trustLoopback: true,
			})?.status,
		).toBe(401);
	});
});

test("forwarding marks and acceptable loopback hosts are precise", () => {
	expect(isForwardedRequest(new Headers({ "x-forwarded-for": "" }))).toBe(
		false,
	);
	expect(
		isForwardedRequest(new Headers({ forwarded: "for=203.0.113.7" })),
	).toBe(true);
	expect(isLocalHostHeader("localhost:8080", "127.0.0.1")).toBe(true);
	expect(isLocalHostHeader("[::1]:8080", "127.0.0.1")).toBe(true);
	expect(isLocalHostHeader("attacker.example", "127.0.0.1")).toBe(false);
});

test("uses every explicit bind host for one private listener set", () => {
	const previousBindHosts = process.env.CF_BIND_HOSTS;
	process.env.CF_BIND_HOSTS = "127.0.0.1, 10.76.0.1,10.76.0.1";

	try {
		const configured = createExposureConfig({ get: () => undefined });

		expect(configured.bindHosts).toEqual(["127.0.0.1", "10.76.0.1"]);
		expect(isLocalHostHeader("10.76.0.1:8080", configured.bindHosts)).toBe(
			true,
		);
		expect(isLocalHostHeader("10.76.0.2:8080", configured.bindHosts)).toBe(
			false,
		);
	} finally {
		if (previousBindHosts === undefined) {
			delete process.env.CF_BIND_HOSTS;
		} else {
			process.env.CF_BIND_HOSTS = previousBindHosts;
		}
	}
});
