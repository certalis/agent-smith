import { expect, test } from "bun:test";
import { hasOrderedProviderFallback } from "./index";

test("allows a named caller to use ordered fallback without any provider pool", () => {
	const routing = {
		apiKeyAccounts: "everyone",
		callers: { box: { allowFallbacks: true } },
		holdSeconds: 0,
		routes: {},
	};
	expect(hasOrderedProviderFallback(routing as never, "box")).toBe(true);
	expect(hasOrderedProviderFallback(routing as never, "other")).toBe(false);
});
