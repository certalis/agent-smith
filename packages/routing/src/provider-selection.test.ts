import { expect, test } from "bun:test";
import {
	higherRankedProviderChoices,
	preferProviders,
	selectPoolProviders,
} from "./provider-selection";

test("keeps a conversation provider first without a provider failover", () => {
	const providers = [
		{ name: "qwen-claude" },
		{ name: "kimi-claude" },
		{ name: "claude-code" },
	];

	expect(
		selectPoolProviders(providers, (provider) => provider.name, {
			pinnedProvider: "kimi-claude",
			preferredProvider: "kimi-claude",
		}),
	).toEqual([{ name: "kimi-claude" }]);
	expect(
		selectPoolProviders(providers, (provider) => provider.name, {
			pinnedProvider: "kimi-claude",
		}),
	).toEqual([{ name: "kimi-claude" }]);
});

test("keeps configured order while filtering promotion choices through routing policy", () => {
	const choices = [
		{ provider: "qwen-claude", model: "qwen3-coder-flash" },
		{ provider: "kimi-claude", model: "kimi-k3.1-pro" },
		{ provider: "claude-code", model: "claude-sonnet-4-5" },
	];

	expect(
		preferProviders(
			choices,
			(choice) => choice.provider,
			undefined,
			"kimi-claude",
		),
	).toEqual([choices[1], choices[0], choices[2]]);
	expect(
		higherRankedProviderChoices(
			choices,
			"claude-code",
			new Set(["qwen-claude", "kimi-claude"]),
			(provider) => provider === "qwen-claude",
		),
	).toEqual([choices[0]]);
});
