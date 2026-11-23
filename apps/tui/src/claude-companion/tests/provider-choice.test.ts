import { expect, test } from "bun:test";
import {
	classifyCapacityResponse,
	readCapacityDetails,
	readPromotionDetails,
	retryCapacityBlockedRequest,
} from "../hooks/provider-choice.js";
import { register } from "../hooks/register.js";

function base64url(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const binary = String.fromCharCode(...bytes);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function fetchResult(value: Record<string, unknown>, sendIndex = 0) {
	return { sendIndex, value };
}

test("recognizes Agent-smith's versioned capacity response before a turn is retried", () => {
	expect(
		classifyCapacityResponse(429, {
			"x-agent-smith-provider-capacity": "v1",
		}),
	).toBe(true);
	expect(
		classifyCapacityResponse(409, {
			"x-agent-smith-provider-capacity": "v1",
		}),
	).toBe(true);
});

test("reads only a valid ranked chooser from the private response header", () => {
	const details = {
		blockedProvider: "qwen-claude",
		category: "token-allocation",
		choices: [
			{ provider: "kimi-claude", model: "kimi-k3.1-pro" },
			{ provider: "claude-code", model: "claude-sonnet-4-5" },
		],
		wait: { retryAt: 1_700_000_000_000 },
	};
	const encoded = base64url(details);

	expect(
		readCapacityDetails({
			"x-agent-smith-provider-capacity-details": encoded,
		}),
	).toEqual(details);
	expect(
		readCapacityDetails({
			"x-agent-smith-provider-capacity-details": "not-a-capacity-problem",
		}),
	).toBeNull();
	expect(
		readPromotionDetails({
			"x-agent-smith-provider-promotion-details": base64url({
				choices: [{ provider: "qwen-claude", model: "qwen3-coder-flash" }],
			}),
		}),
	).toEqual({
		choices: [{ provider: "qwen-claude", model: "qwen3-coder-flash" }],
	});
});

test("recognizes five-hour and weekly seat limits from the pool", () => {
	for (const category of ["five-hour-limit", "weekly-limit"]) {
		expect(
			readCapacityDetails({
				"x-agent-smith-provider-capacity-details": base64url({
					blockedProvider: "claude-code",
					category,
					choices: [{ provider: "qwen-claude", model: "qwen3-coder" }],
					wait: { retryAt: 1_700_000_000_000 },
				}),
			}),
		).toMatchObject({ category });
	}
});

test("asks out of band, retries the same request on the selected provider, and shows the provider that served it", async () => {
	const calls: Array<{ body?: unknown; headers?: Record<string, string> }> = [];
	const statuses: string[] = [];
	const details = base64url({
		blockedProvider: "qwen-claude",
		category: "token-allocation",
		choices: [{ provider: "kimi-claude", model: "kimi-k3.1-pro" }],
		wait: null,
	});
	const response = await retryCapacityBlockedRequest({
		init: {
			method: "POST",
			headers: { "x-api-key": "test" },
			body: "same body",
		},
		ask: async () => "Kimi · kimi-k3.1-pro",
		setStatus: (status) => statuses.push(status),
		send: async (init) => {
			calls.push({ body: init.body, headers: init.headers });
			return calls.length === 1
				? fetchResult({
						status: 429,
						ok: false,
						headers: {
							"x-agent-smith-provider-capacity": "v1",
							"x-agent-smith-provider-capacity-details": details,
						},
						text: "",
						isStreaming: true,
					})
				: fetchResult(
						{
							status: 200,
							ok: true,
							headers: {
								"x-agent-smith-served-provider": "kimi-claude",
								"x-agent-smith-served-model": "kimi-k3.1-pro",
							},
							text: "",
							isStreaming: true,
						},
						1,
					);
		},
	});

	expect(response).toMatchObject({ sendIndex: 1, value: { status: 200 } });
	expect(calls).toEqual([
		{
			body: "same body",
			headers: {
				"x-api-key": "test",
				"x-agent-smith-interactive-provider-choice": "v1",
			},
		},
		{
			body: "same body",
			headers: {
				"x-api-key": "test",
				"x-agent-smith-interactive-provider-choice": "v1",
				"x-agent-smith-provider-choice": "kimi-claude",
			},
		},
	]);
	expect(statuses).toEqual(["Kimi · kimi-k3.1-pro"]);
});

test("returns the original capacity response when the chooser is dismissed", async () => {
	const statuses: string[] = [];
	const response = await retryCapacityBlockedRequest({
		init: { method: "POST", body: "same body" },
		ask: async () => {
			throw new Error("dismissed");
		},
		setStatus: (status) => statuses.push(status),
		send: async () =>
			fetchResult({
				status: 429,
				ok: false,
				headers: {
					"x-agent-smith-provider-capacity": "v1",
					"x-agent-smith-provider-capacity-details": base64url({
						blockedProvider: "qwen-claude",
						category: "token-allocation",
						choices: [{ provider: "kimi-claude", model: "kimi-k3.1-pro" }],
						wait: null,
					}),
				},
			}),
	});

	expect(response).toMatchObject({ value: { status: 429 } });
	expect(statuses).toEqual([
		"Agent-smith: provider choice dismissed; this turn remains blocked.",
	]);
});

test("does not turn typed chooser text into a provider wait", async () => {
	const calls: unknown[] = [];
	const statuses: string[] = [];
	const response = await retryCapacityBlockedRequest({
		init: { method: "POST", body: "same body" },
		ask: async () => "something else",
		setStatus: (status) => statuses.push(status),
		send: async (init) => {
			calls.push(init);
			return fetchResult({
				status: 429,
				ok: false,
				headers: {
					"x-agent-smith-provider-capacity": "v1",
					"x-agent-smith-provider-capacity-details": base64url({
						blockedProvider: "qwen-claude",
						category: "request-rate",
						choices: [{ provider: "kimi-claude", model: "kimi-k3.1-pro" }],
						wait: { retryAt: 1_700_000_000_000 },
					}),
				},
			});
		},
	});

	expect(response).toMatchObject({ value: { status: 429 } });
	expect(calls).toHaveLength(1);
	expect(statuses).toEqual([
		"Agent-smith: choose one listed provider or Wait; this turn remains blocked.",
	]);
});

test("does not repeat an unknown-limit request when the person chooses Wait", async () => {
	const calls: unknown[] = [];
	const statuses: string[] = [];
	const response = await retryCapacityBlockedRequest({
		init: {
			method: "POST",
			headers: { "x-api-key": "test" },
			body: "same body",
		},
		ask: async () => "Wait",
		setStatus: (status) => statuses.push(status),
		send: async (init) => {
			calls.push(init);
			return fetchResult({
				status: 429,
				ok: false,
				headers: {
					"x-agent-smith-provider-capacity": "v1",
					"x-agent-smith-provider-capacity-details": base64url({
						blockedProvider: "qwen-claude",
						category: "dynamic-throughput",
						choices: [{ provider: "kimi-claude", model: "kimi-k3.1-pro" }],
						wait: null,
					}),
				},
				text: "",
				isStreaming: true,
			});
		},
	});

	expect(response).toMatchObject({ value: { status: 429 } });
	expect(calls).toHaveLength(1);
	expect(statuses).toEqual([
		"Agent-smith: the provider supplied no retry time, so this turn remains on its current provider.",
	]);
});

test("reports when the server cannot hold a known provider wait", async () => {
	const statuses: string[] = [];
	const details = base64url({
		blockedProvider: "qwen-claude",
		category: "request-rate",
		choices: [{ provider: "kimi-claude", model: "kimi-k3.1-pro" }],
		wait: { retryAt: 1_700_000_000_000 },
	});
	const response = await retryCapacityBlockedRequest({
		init: { method: "POST", body: "same body" },
		ask: async () => "Wait",
		setStatus: (status) => statuses.push(status),
		send: async () =>
			fetchResult({
				status: 429,
				ok: false,
				headers: {
					"x-agent-smith-provider-capacity": "v1",
					"x-agent-smith-provider-capacity-details": details,
				},
			}),
	});

	expect(response).toMatchObject({ value: { status: 429 } });
	expect(statuses).toEqual([
		"Agent-smith: it cannot hold this request until the provider retry time, so this turn remains blocked.",
	]);
});

test("offers a recovered higher provider on the next completed main turn", async () => {
	const handlers = new Map();
	register((event, _matcher, handler) => {
		const resolvedHandler = handler ?? _matcher;
		handlers.set(event, resolvedHandler);
		return { catch() {} };
	});
	const asks: string[] = [];
	const status: string[] = [];
	const $ = {
		command: { register: async () => {} },
		ui: {
			ask: async (question) => {
				asks.push(question);
				return "Qwen · qwen3-coder-flash";
			},
			status: (value) => status.push(value),
		},
	};
	const event = {
		url: "http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		init: { method: "POST", headers: {} },
	};
	const fetch = handlers.get("http.fetch");
	const complete = handlers.get("turn.complete");

	await fetch($, event, async () =>
		fetchResult({
			status: 200,
			ok: true,
			headers: {
				"x-agent-smith-provider-promotion-details": base64url({
					choices: [{ provider: "qwen-claude", model: "qwen3-coder-flash" }],
				}),
			},
		}),
	);
	expect(asks).toEqual([]);

	await complete($, {}, async () => ({}));
	const sentHeaders: Record<string, string>[] = [];
	await fetch($, event, async (nextEvent) => {
		sentHeaders.push(nextEvent.init.headers);
		return fetchResult({ status: 200, ok: true, headers: {} });
	});

	expect(asks).toEqual([
		"A higher-ranked provider has an eligible Agent-smith account. Switch this conversation?",
	]);
	expect(sentHeaders).toEqual([
		{
			"x-agent-smith-interactive-provider-choice": "v1",
			"x-agent-smith-provider-choice": "qwen-claude",
		},
	]);
	expect(status).toEqual([]);
});

test("shares one recovery choice across concurrent requests in the next turn", async () => {
	const handlers = new Map();
	register((event, _matcher, handler) => {
		handlers.set(event, handler ?? _matcher);
		return { catch() {} };
	});
	let resolveAsk: (answer: string) => void = () => {};
	const asks: string[] = [];
	const $ = {
		command: { register: async () => {} },
		ui: {
			ask: async (question) => {
				asks.push(question);
				return await new Promise((resolve) => {
					resolveAsk = resolve;
				});
			},
			status() {},
		},
	};
	const event = {
		url: "http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		init: { method: "POST", headers: {} },
	};
	const fetch = handlers.get("http.fetch");
	await fetch($, event, async () =>
		fetchResult({
			status: 200,
			ok: true,
			headers: {
				"x-agent-smith-provider-promotion-details": base64url({
					choices: [{ provider: "qwen-claude", model: "qwen3-coder-flash" }],
				}),
			},
		}),
	);
	await handlers.get("turn.complete")($, {}, async () => ({}));

	const sent: Record<string, string>[] = [];
	const send = async (nextEvent) => {
		sent.push(nextEvent.init.headers);
		return fetchResult({ status: 200, ok: true, headers: {} });
	};
	const first = fetch($, event, send);
	await Promise.resolve();
	const second = fetch($, event, send);
	await Promise.resolve();

	expect(asks).toHaveLength(1);
	resolveAsk("Qwen · qwen3-coder-flash");
	await Promise.all([first, second]);
	expect(sent).toEqual([
		{
			"x-agent-smith-interactive-provider-choice": "v1",
			"x-agent-smith-provider-choice": "qwen-claude",
		},
		{
			"x-agent-smith-interactive-provider-choice": "v1",
			"x-agent-smith-provider-choice": "qwen-claude",
		},
	]);
});

test("shares one blocked-provider chooser across concurrent pool requests", async () => {
	const handlers = new Map();
	register((event, _matcher, handler) => {
		handlers.set(event, handler ?? _matcher);
		return { catch() {} };
	});
	let resolveAsk: (answer: string) => void = () => {};
	const asks: string[] = [];
	const $ = {
		command: { register: async () => {} },
		ui: {
			ask: async (question) => {
				asks.push(question);
				return await new Promise((resolve) => {
					resolveAsk = resolve;
				});
			},
			status() {},
		},
	};
	const event = {
		url: "http://localhost:8080/v1/pool/anthropic-messages/v1/messages",
		init: { method: "POST", headers: {} },
	};
	const details = base64url({
		blockedProvider: "qwen-claude",
		category: "burst",
		choices: [{ provider: "kimi-claude", model: "kimi-k3.1-pro" }],
		wait: null,
	});
	const headers: Record<string, string>[] = [];
	const send = async (nextEvent) => {
		headers.push(nextEvent.init.headers);
		return nextEvent.init.headers["x-agent-smith-provider-choice"]
			? fetchResult({ status: 200, ok: true, headers: {} }, 1)
			: fetchResult({
					status: 429,
					ok: false,
					headers: {
						"x-agent-smith-provider-capacity": "v1",
						"x-agent-smith-provider-capacity-details": details,
					},
				});
	};
	const fetch = handlers.get("http.fetch");
	const first = fetch($, event, send);
	await Promise.resolve();
	const second = fetch($, event, send);
	await Promise.resolve();

	expect(asks).toEqual([
		"Qwen cannot serve this turn because of traffic burst. Switch provider?",
	]);
	resolveAsk("Kimi · kimi-k3.1-pro");
	const results = await Promise.all([first, second]);
	expect(results).toEqual([
		expect.objectContaining({
			sendIndex: 1,
			value: { status: 200, ok: true, headers: {} },
		}),
		expect.objectContaining({
			sendIndex: 1,
			value: { status: 200, ok: true, headers: {} },
		}),
	]);
	expect(headers).toEqual([
		{ "x-agent-smith-interactive-provider-choice": "v1" },
		{ "x-agent-smith-interactive-provider-choice": "v1" },
		{
			"x-agent-smith-interactive-provider-choice": "v1",
			"x-agent-smith-provider-choice": "kimi-claude",
		},
		{
			"x-agent-smith-interactive-provider-choice": "v1",
			"x-agent-smith-provider-choice": "kimi-claude",
		},
	]);
});
