import { expect, test } from "bun:test";
import {
	type TeamRoutingConfig,
	WINDOW_WARMUP_DEFAULTS,
} from "@agent-smith/config";
import { TeamRouter, type TeamRoutingRequest } from "@agent-smith/pool";
import type { Provider } from "@agent-smith/providers";
import { getConversationProviderKey } from "@agent-smith/routing";

const config: TeamRoutingConfig = {
	admissionCap: 5,
	admissionQueueLimit: 25,
	admissionWaitMs: 30_000,
	allowlistedAccountUuids: [],
	distributionEnabled: true,
	preferExpiringQuota: false,
	enabled: true,
	holdSeconds: 0,
	maxUsage: 0.9,
	weeklyMaxUsage: 0.9,
	weeklyMaxUsageByEmail: {},
	callerWeeklyMaxUsage: {},
	callerProviderFallback: {},
	quotaProbeSeconds: 0,
	windowWarmup: WINDOW_WARMUP_DEFAULTS,
};

const body = new TextEncoder().encode(
	'{"messages":[{"role":"user","content":"hello"}],"alternate":"other"}',
).buffer;
const first = {
	getConversationOpening: (value: Record<string, unknown>) => value.messages,
	weeklyBucketFor: (model: string | undefined) =>
		model === "claude-opus-4-5" ? "weekly-opus" : undefined,
} as unknown as Provider;
const second = {
	...first,
	getConversationOpening: (value: Record<string, unknown>) => value.alternate,
} as unknown as Provider;
const request: TeamRoutingRequest = {
	body,
	contentType: "application/json",
	model: "claude-opus-4-5",
	provider: "claude-code",
	sessionId: "session-1",
};
const pooled: TeamRoutingRequest = {
	...request,
	pinScope: "pool:anthropic-messages",
	pinBucket: "claude-opus-4-5",
};

test("direct and pooled conversation keys remain byte-identical", () => {
	const router = new TeamRouter();
	expect(router.getConversationPinKey(request, config, first)).toBe(
		"11874ef0d503778259f5d8edbd86a69e16e1fe88216b9d5b005d7d83acbd2ec0",
	);
	expect(
		router.getConversationPinKey(
			{ ...request, model: "unknown" },
			config,
			first,
		),
	).toBe("fcb79d8bb937d8177c100e110d8fea406a47a98d948006b091cffdfb398ba83d");
	expect(router.getConversationPinKey(pooled, config, first)).toBe(
		"cdd09933e1e8dd79417c5f52f8cf61e5b3c2d122854fdc2c24a60abad3d2516a",
	);
	expect(getConversationProviderKey(request)).toBe(
		"cabc45a4cd63272f28ec56efd4edf37ac9974ff4ae4f94df4bd6e10e3625fa0f",
	);
	expect(getConversationProviderKey(pooled)).toBe(
		"83401ab8220e1e68c34afc4a89748064c34cd31cca3f6496795d1e4c2ea9e58b",
	);
});

test("pool lookup uses the first parser and rebind uses the serving parser", () => {
	const pins = new Map([
		[
			"cdd09933e1e8dd79417c5f52f8cf61e5b3c2d122854fdc2c24a60abad3d2516a",
			{ accountId: "second-seat", lastSeenAt: 1_700_000_000_000 },
		],
	]);
	const store = {
		countConversationPinsByAccount: () => new Map<string, number>(),
		deleteExpiredConversationPins: () => undefined,
		getConversationPin: (key: string) => pins.get(key) ?? null,
		upsertConversationPin: (
			key: string,
			accountId: string,
			lastSeenAt: number,
		) => {
			pins.set(key, { accountId, lastSeenAt });
		},
	};
	const router = new TeamRouter();
	const now = 1_700_000_000_000;
	expect(router.getPinnedAccountId(pooled, config, first, store, now)).toBe(
		"second-seat",
	);
	expect(
		router.getPinnedAccountId(pooled, config, second, store, now),
	).toBeUndefined();
	router.rebind(pooled, "second-seat", config, second, store, now);
	expect(
		pins.get("5a1899acb2f1d6c6bf7b02f467c004530d05edde13f3e7ffa6a87838fd31ce20")
			?.accountId,
	).toBe("second-seat");
});

test("an opaque first-provider opening digest preserves lookup and serving-parser rebind", () => {
	const pins = new Map([
		[
			"cdd09933e1e8dd79417c5f52f8cf61e5b3c2d122854fdc2c24a60abad3d2516a",
			{ accountId: "second-seat", lastSeenAt: 1_700_000_000_000 },
		],
	]);
	const store = {
		countConversationPinsByAccount: () => new Map<string, number>(),
		deleteExpiredConversationPins: () => undefined,
		getConversationPin: (key: string) => pins.get(key) ?? null,
		upsertConversationPin: (
			key: string,
			accountId: string,
			lastSeenAt: number,
		) => {
			pins.set(key, { accountId, lastSeenAt });
		},
	};
	const router = new TeamRouter();
	const digest = new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify(
				first.getConversationOpening?.(
					JSON.parse(new TextDecoder().decode(body)),
				),
			),
		)
		.digest("hex");
	const routed = { ...pooled, lookupOpeningDigest: digest };
	const now = 1_700_000_000_000;
	expect(router.getPinnedAccountId(routed, config, second, store, now)).toBe(
		"second-seat",
	);
	router.rebind(routed, "second-seat", config, second, store, now);
	expect(
		pins.get("5a1899acb2f1d6c6bf7b02f467c004530d05edde13f3e7ffa6a87838fd31ce20")
			?.accountId,
	).toBe("second-seat");
});
