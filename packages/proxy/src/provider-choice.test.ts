import { expect, test } from "bun:test";
import {
	capacityChoices,
	createProviderCapacityProblem,
	createProviderChoiceProblem,
	interactiveProviderChoiceRequested,
	providerPromotionDeclined,
	readProviderChoice,
	stripProviderChoiceHeaders,
	withProviderPromotionDetails,
	withServedProviderHeaders,
} from "@agent-smith/routing";

const candidates = [
	{ model: "qwen3-coder-flash", provider: "qwen-claude" },
	{ model: "kimi-k3.1-pro", provider: "kimi-claude" },
	{ model: "claude-sonnet-4-5", provider: "claude-code" },
];

test("offers every eligible replacement in configured order and excludes the blocked provider", () => {
	expect(
		capacityChoices(candidates, "qwen-claude", new Set(["kimi-claude"])),
	).toEqual([{ model: "kimi-k3.1-pro", provider: "kimi-claude" }]);
});

test("accepts only a current offered choice and removes Agent-smith controls before forwarding", () => {
	const headers = new Headers({
		"x-agent-smith-interactive-provider-choice": "v1",
		"x-agent-smith-provider-choice": "kimi-claude",
		"x-agent-smith-provider-promotion-declined": "v1",
		"x-api-key": "proxy-key",
	});
	const choices = capacityChoices(
		candidates,
		"qwen-claude",
		new Set(["kimi-claude"]),
	);

	expect(interactiveProviderChoiceRequested(headers)).toBe(true);
	expect(readProviderChoice(headers, choices)).toBe("kimi-claude");
	expect(readProviderChoice(headers, [])).toBeNull();
	expect(providerPromotionDeclined(headers)).toBe(true);
	const forwarded = stripProviderChoiceHeaders(headers);
	expect(forwarded.get("x-agent-smith-interactive-provider-choice")).toBeNull();
	expect(forwarded.get("x-agent-smith-provider-choice")).toBeNull();
	expect(forwarded.get("x-agent-smith-provider-promotion-declined")).toBeNull();
	expect(forwarded.get("x-api-key")).toBe("proxy-key");
});

test("returns a versioned capacity problem without a made-up wait deadline", async () => {
	const response = createProviderCapacityProblem({
		blockedProvider: "qwen-claude",
		category: "token-allocation",
		choices: [{ model: "kimi-k3.1-pro", provider: "kimi-claude" }],
	});

	expect(response.status).toBe(429);
	expect(response.headers.get("content-type")).toContain(
		"application/problem+json",
	);
	expect(await response.json()).toEqual({
		type: "urn:agent-smith:provider-capacity:v1",
		title: "Current provider cannot serve this turn",
		status: 429,
		blockedProvider: "qwen-claude",
		category: "token-allocation",
		choices: [{ model: "kimi-k3.1-pro", provider: "kimi-claude" }],
		wait: null,
	});
});

test("returns a marked private menu without calling a provider unavailable", async () => {
	const response = createProviderChoiceProblem({
		activeProvider: "kimi-claude",
		choices: [{ model: "qwen3-coder-flash", provider: "qwen-claude" }],
	});

	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({
		title: "Choose provider for this turn",
		activeProvider: "kimi-claude",
	});
});

test("reports the provider and mapped model that actually served a pooled response", async () => {
	const response = withServedProviderHeaders(
		new Response('{"ok":true}', {
			headers: { "content-type": "application/json" },
		}),
		{ model: "kimi-k3.1-pro", provider: "kimi-claude" },
	);

	expect(response.headers.get("x-agent-smith-served-provider")).toBe(
		"kimi-claude",
	);
	expect(response.headers.get("x-agent-smith-served-model")).toBe(
		"kimi-k3.1-pro",
	);
	expect(await response.text()).toBe('{"ok":true}');
});

test("offers an eligible higher-ranked provider without claiming its upstream is healthy", () => {
	const response = withProviderPromotionDetails(new Response("ok"), [
		{ model: "qwen3-coder-flash", provider: "qwen-claude" },
	]);

	expect(
		response.headers.get("x-agent-smith-provider-promotion-details"),
	).toBeTruthy();
});
