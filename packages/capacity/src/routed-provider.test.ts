import { expect, test } from "bun:test";
import type {
	Availability,
	RoutedProvider,
	RouteRequest,
	ServeOutcome,
	SessionOutcome,
} from ".";

test("the provider boundary exposes advisory capacity and a typed final response", () => {
	const availability: Availability = {
		capacity: { state: "unknown" },
		holdsConversation: false,
		threadRequest: false,
	};
	const outcome: ServeOutcome = {
		kind: "final",
		response: new Response("ok"),
		providerServed: true,
	};
	const provider: Pick<RoutedProvider, "availability" | "serve"> = {
		async availability(_request: RouteRequest) {
			return availability;
		},
		async serve(_request: RouteRequest) {
			return outcome;
		},
	};
	expect(provider.availability).toBeFunction();
	expect(provider.serve).toBeFunction();
	const session: SessionOutcome = {
		kind: "unavailable",
		reason: "not-supported",
	};
	expect(session.kind).toBe("unavailable");
});
