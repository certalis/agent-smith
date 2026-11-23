import { expect, test } from "bun:test";
import {
	capacityChoices,
	createProviderCapacityProblem,
	stripProviderChoiceHeaders,
} from "./index";

test("owns the provider chooser protocol without a pool or connector", async () => {
	const choices = capacityChoices(
		[
			{ model: "qwen3-coder-flash", provider: "qwen-claude" },
			{ model: "kimi-k3.1-pro", provider: "kimi-claude" },
		],
		"qwen-claude",
		new Set(["kimi-claude"]),
	);
	const response = createProviderCapacityProblem({
		blockedProvider: "qwen-claude",
		category: "token-allocation",
		choices,
	});

	expect(await response.json()).toMatchObject({ choices });
	expect(response.headers.get("x-should-retry")).toBe("false");
	expect(
		stripProviderChoiceHeaders(
			new Headers({ "x-agent-smith-provider-choice": "kimi-claude" }),
		).has("x-agent-smith-provider-choice"),
	).toBe(false);
});
