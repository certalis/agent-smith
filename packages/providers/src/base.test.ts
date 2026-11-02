import { expect, test } from "bun:test";
import { BaseProvider } from "./base";

class PlainProvider extends BaseProvider {
	name = "plain";
	defaultBaseUrl = "https://plain.example";
	wire = "anthropic-messages" as const;
}

test("does not interpret Anthropic quota headers for a plain API provider", () => {
	const rateLimit = new PlainProvider().parseRateLimit(
		new Response("{}", {
			headers: {
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": "123",
			},
		}),
	);

	expect(rateLimit).toEqual({ isRateLimited: false });
});
