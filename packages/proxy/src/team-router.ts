import { createHash } from "node:crypto";
import type { TeamRoutingConfig } from "@ccflare/config";
import type { Provider } from "@ccflare/providers";
import type { Account, AccountProvider } from "@ccflare/types";

const MAX_OPENING_BYTES = 64 * 1024;
const PIN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type TeamRoutingRequest = {
	body: ArrayBuffer | null;
	contentType: string | null;
	manualAccountName?: string;
	model: string | undefined;
	pinBucket?: string;
	pinScope?: string;
	provider: AccountProvider;
	sessionId: string | null;
};

export type ConversationPinStore = {
	countConversationPinsByAccount(activeSince: number): Map<string, number>;
	deleteExpiredConversationPins(before: number): void;
	getConversationPin(pinKey: string): ConversationPin | null;
	upsertConversationPin(
		pinKey: string,
		accountId: string,
		lastSeenAt: number,
	): void;
};

type ConversationPin = {
	accountId: string;
	lastSeenAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openingDigest(
	request: TeamRoutingRequest,
	provider: Provider,
): string | null {
	if (
		!request.body ||
		request.body.byteLength > MAX_OPENING_BYTES ||
		!request.contentType?.toLowerCase().includes("application/json")
	) {
		return null;
	}

	try {
		const parsed = JSON.parse(
			new TextDecoder().decode(request.body),
		) as unknown;
		if (!isRecord(parsed)) return null;
		const opening = provider.getConversationOpening?.(parsed);
		if (opening === null) return null;
		return createHash("sha256").update(JSON.stringify(opening)).digest("hex");
	} catch {
		return null;
	}
}

function pinKey(
	request: TeamRoutingRequest,
	provider: Provider,
): string | null {
	if (!request.sessionId) return null;
	const digest = openingDigest(request, provider) ?? "no-opening";
	return createHash("sha256")
		.update(
			[
				request.pinScope ?? request.provider,
				request.pinBucket ?? provider.weeklyBucketFor(request.model) ?? "",
				request.sessionId,
				digest,
			].join("\u0000"),
		)
		.digest("hex");
}

export function isAllowlisted(
	account: Account,
	config: TeamRoutingConfig,
): boolean {
	return (
		account.auth_method === "oauth" &&
		account.account_uuid !== null &&
		account.account_uuid !== undefined &&
		config.allowlistedAccountUuids.includes(account.account_uuid)
	);
}

/**
 * Small, proxy-owned state for W3 team routing. It intentionally knows nothing
 * about provider HTTP details or database SQL.
 */
export class TeamRouter {
	private readonly inFlight = new Map<string, number>();
	private readonly pins = new Map<string, ConversationPin>();

	order(
		accounts: Account[],
		request: TeamRoutingRequest | undefined,
		config: TeamRoutingConfig,
		provider: Provider,
		store?: ConversationPinStore,
		now: number = Date.now(),
	): Account[] {
		if (!config.enabled || !request) return accounts;
		this.removeExpiredPins(now, store);

		const eligible = this.eligibleAccounts(accounts, request, config);
		if (eligible.length === 0) return [];

		const key = pinKey(request, provider);
		const pinnedId = this.getPinnedAccountId(
			request,
			config,
			provider,
			store,
			now,
		);
		const pinned = pinnedId
			? eligible.find((account) => account.id === pinnedId)
			: undefined;
		if (pinned && key) {
			this.touchPin(key, pinned.id, now, store);
			return [
				pinned,
				...eligible.filter((account) => account.id !== pinned.id),
			];
		}

		if (!config.distributionEnabled || !key) return eligible;

		const selected = this.leastLoadedPriorityAccount(
			eligible,
			store?.countConversationPinsByAccount(now - PIN_TTL_MS),
		);
		this.touchPin(key, selected.id, now, store);
		return [
			selected,
			...eligible.filter((account) => account.id !== selected.id),
		];
	}

	/** Applies the account-safety part of team routing without creating a pin. */
	eligibleAccounts(
		accounts: Account[],
		request: TeamRoutingRequest | undefined,
		config: TeamRoutingConfig,
	): Account[] {
		if (!config.enabled) return accounts;
		const eligible = accounts.filter((account) =>
			isAllowlisted(account, config),
		);
		if (!request?.manualAccountName) return eligible;
		return eligible.filter(
			(account) => account.name === request.manualAccountName,
		);
	}

	/** Returns a still-valid pin without selecting or rebinding an account. */
	getPinnedAccountId(
		request: TeamRoutingRequest | undefined,
		config: TeamRoutingConfig,
		provider: Provider,
		store?: ConversationPinStore,
		now: number = Date.now(),
	): string | undefined {
		if (!config.enabled || !request?.sessionId || request.manualAccountName) {
			return undefined;
		}
		this.removeExpiredPins(now, store);
		const key = pinKey(request, provider);
		return key
			? (this.pins.get(key) ?? store?.getConversationPin(key))?.accountId
			: undefined;
	}

	begin(accountId: string): void {
		this.inFlight.set(accountId, (this.inFlight.get(accountId) ?? 0) + 1);
	}

	end(accountId: string): void {
		const current = this.inFlight.get(accountId) ?? 0;
		if (current <= 1) {
			this.inFlight.delete(accountId);
			return;
		}
		this.inFlight.set(accountId, current - 1);
	}

	/** Move a conversation only after its prior account became ineligible. */
	rebind(
		request: TeamRoutingRequest | undefined,
		accountId: string,
		config: TeamRoutingConfig,
		provider: Provider,
		store?: ConversationPinStore,
		now: number = Date.now(),
	): void {
		if (!config.enabled || request?.manualAccountName) return;
		const key = request ? pinKey(request, provider) : null;
		if (key) this.touchPin(key, accountId, now, store);
	}

	private activePins(
		accountId: string,
		persistedCounts: ReadonlyMap<string, number> | undefined,
	): number {
		if (persistedCounts) return persistedCounts.get(accountId) ?? 0;
		return [...this.pins.values()].filter((pin) => pin.accountId === accountId)
			.length;
	}

	private leastLoadedPriorityAccount(
		accounts: Account[],
		persistedCounts: ReadonlyMap<string, number> | undefined,
	): Account {
		const priority = Math.min(
			...accounts.map((account) => account.priority ?? 0),
		);
		const tier = accounts.filter(
			(account) => (account.priority ?? 0) === priority,
		);
		return [...tier].sort((left, right) => {
			const activeDifference =
				this.activePins(left.id, persistedCounts) -
				this.activePins(right.id, persistedCounts);
			if (activeDifference !== 0) return activeDifference;
			const inFlightDifference =
				(this.inFlight.get(left.id) ?? 0) - (this.inFlight.get(right.id) ?? 0);
			if (inFlightDifference !== 0) return inFlightDifference;
			return left.name.localeCompare(right.name);
		})[0] as Account;
	}

	private removeExpiredPins(now: number, store?: ConversationPinStore): void {
		for (const [key, pin] of this.pins) {
			if (now - pin.lastSeenAt > PIN_TTL_MS) this.pins.delete(key);
		}
		store?.deleteExpiredConversationPins(now - PIN_TTL_MS);
	}

	private touchPin(
		key: string,
		accountId: string,
		now: number,
		store?: ConversationPinStore,
	): void {
		this.pins.set(key, { accountId, lastSeenAt: now });
		store?.upsertConversationPin(key, accountId, now);
	}
}
