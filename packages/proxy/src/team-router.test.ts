import { expect, test } from "bun:test";
import type { TeamRoutingConfig } from "@agent-smith/config";
import type { Provider } from "@agent-smith/providers";
import type { Account } from "@agent-smith/types";
import { TeamRouter, type TeamRoutingRequest } from "./team-router";

const config: TeamRoutingConfig = {
	admissionCap: 5,
	admissionQueueLimit: 25,
	admissionWaitMs: 30_000,
	allowlistedAccountUuids: [],
	distributionEnabled: true,
	enabled: true,
	holdSeconds: 0,
	maxUsage: 0.9,
	quotaProbeSeconds: 0,
};

const provider = {
	getConversationOpening: (body: Record<string, unknown>) => body.messages,
	weeklyBucketFor: () => "weekly",
} as unknown as Provider;

const poolRequest = (providerName: string): TeamRoutingRequest => ({
	body: new TextEncoder().encode('{"messages":[]}').buffer,
	contentType: "application/json",
	model: "claude-sonnet-4-5",
	pinBucket: "claude-sonnet-4-5",
	pinScope: "pool:anthropic-messages",
	provider: providerName,
	sessionId: "pool-session",
});

test("a new conversation takes the seat with the lowest five-hour usage, not the fewest pins", () => {
	const now = 1_700_000_000_000;
	const fiveHour = (utilization: number) => ({
		quota_state: {
			windows: {
				unified5h: {
					resetAt: now + 60 * 60 * 1_000,
					seenAt: now,
					status: "allowed",
					utilization,
				},
			},
		},
	});
	const pooledSeat = (name: string, utilization: number) => ({
		id: name,
		name,
		priority: 0,
		auth_method: "oauth",
		account_uuid: name,
		...fiveHour(utilization),
	});
	const seats = [
		pooledSeat("busy", 0.5),
		pooledSeat("quiet", 0.1),
	] as unknown as Account[];
	const usageProvider = {
		...provider,
		quotaBucketsFor: () => undefined,
		isWeeklyBucket: () => false,
		isFiveHourBucket: (bucket: string) => bucket === "unified5h",
	} as unknown as Provider;
	const store = {
		countConversationPinsByAccount: () => new Map([["quiet", 3]]),
		deleteExpiredConversationPins: () => undefined,
		getConversationPin: () => null,
		upsertConversationPin: () => undefined,
	};

	const [selected] = new TeamRouter().order(
		seats,
		poolRequest("claude-code"),
		{ ...config, allowlistedAccountUuids: ["busy", "quiet"] },
		usageProvider,
		store,
		now,
	);

	expect(selected?.name).toBe("quiet");
});

test("a pool pin is readable across compatible providers after a serving rebind", () => {
	const router = new TeamRouter();
	const pins = new Map<string, { accountId: string; lastSeenAt: number }>();
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

	router.rebind(poolRequest("acme"), "acme-account", config, provider, store);

	expect(
		router.getPinnedAccountId(
			poolRequest("claude-code"),
			config,
			provider,
			store,
		),
	).toBe("acme-account");
});
