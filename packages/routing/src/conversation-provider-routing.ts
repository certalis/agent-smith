import type { ProviderCapacityBlock } from "@agent-smith/capacity";

export type ConversationProviderPreference = {
	lastSeenAt: number;
	promotionDeclined: boolean;
	provider: string;
};

export type ConversationProviderBlock = ProviderCapacityBlock & {
	lastSeenAt: number;
};

/** The only persistence surface routing needs; pool supplies the implementation. */
export interface ConversationProviderRoutingStore {
	deleteBlock(conversationKey: string, provider: string): void;
	getBlock(
		conversationKey: string,
		provider: string,
	): ConversationProviderBlock | null;
	getPreference(conversationKey: string): ConversationProviderPreference | null;
	upsertBlock(
		conversationKey: string,
		provider: string,
		block: ConversationProviderBlock,
	): void;
	upsertPreference(
		conversationKey: string,
		preference: ConversationProviderPreference,
	): void;
}

/** Provider-choice policy without account, credential, or SQL knowledge. */
export class ConversationProviderRouting {
	constructor(private readonly store: ConversationProviderRoutingStore) {}

	getPreference(
		conversationKey: string,
	): ConversationProviderPreference | null {
		return this.store.getPreference(conversationKey);
	}

	getBlock(
		conversationKey: string,
		provider: string,
	): ConversationProviderBlock | null {
		return this.store.getBlock(conversationKey, provider);
	}

	selectProvider(conversationKey: string, provider: string, now: number): void {
		this.store.upsertPreference(conversationKey, {
			lastSeenAt: now,
			promotionDeclined: false,
			provider,
		});
	}

	declinePromotion(conversationKey: string, now: number): void {
		const preference = this.store.getPreference(conversationKey);
		if (!preference) return;
		this.store.upsertPreference(conversationKey, {
			...preference,
			lastSeenAt: now,
			promotionDeclined: true,
		});
	}

	recordBlock(
		conversationKey: string,
		provider: string,
		block: ProviderCapacityBlock,
		now: number,
	): void {
		this.store.upsertBlock(conversationKey, provider, {
			...block,
			lastSeenAt: now,
		});
	}

	clearBlock(conversationKey: string, provider: string): void {
		this.store.deleteBlock(conversationKey, provider);
	}

	/** An unknown upstream block is never treated as recovered. */
	canOfferProvider(
		conversationKey: string,
		provider: string,
		now: number,
	): boolean {
		const block = this.store.getBlock(conversationKey, provider);
		return (
			block === null || (block.retryAt !== undefined && block.retryAt <= now)
		);
	}
}
