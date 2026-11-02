import { expect, test } from "bun:test";
import type { TeamRoutingConfig } from "@ccflare/config";
import type { Provider } from "@ccflare/providers";
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
