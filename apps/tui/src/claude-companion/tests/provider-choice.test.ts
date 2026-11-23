import { expect, test } from "bun:test";
import {
	classifyCapacityResponse,
	readCapacityDetails,
	readPromotionDetails,
	retryCapacityBlockedRequest,
} from "../hooks/provider-choice.js";

function base64url(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const binary = String.fromCharCode(...bytes);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
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
				? {
						status: 429,
						ok: false,
						headers: {
							"x-agent-smith-provider-capacity": "v1",
							"x-agent-smith-provider-capacity-details": details,
						},
						text: "",
						isStreaming: true,
					}
				: {
						status: 200,
						ok: true,
						headers: {
							"x-agent-smith-served-provider": "kimi-claude",
							"x-agent-smith-served-model": "kimi-k3.1-pro",
						},
						text: "",
						isStreaming: true,
					};
		},
	});

	expect(response.status).toBe(200);
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
	expect(statuses).toEqual(["Agent-smith: kimi-claude · kimi-k3.1-pro"]);
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
			return {
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
			};
		},
	});

	expect(response.status).toBe(429);
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
		send: async () => ({
			status: 429,
			ok: false,
			headers: {
				"x-agent-smith-provider-capacity": "v1",
				"x-agent-smith-provider-capacity-details": details,
			},
		}),
	});

	expect(response.status).toBe(429);
	expect(statuses).toEqual([
		"Agent-smith: it cannot hold this request until the provider retry time, so this turn remains blocked.",
	]);
});
