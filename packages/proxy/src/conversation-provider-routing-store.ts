import { isProviderBlockCategory } from "@agent-smith/capacity";
import type { DatabaseOperations } from "@agent-smith/database";
import type {
	ConversationProviderBlock,
	ConversationProviderPreference,
	ConversationProviderRoutingStore,
} from "@agent-smith/routing";

/** SQLite adapter for the Router conversation store. */
export class SqliteConversationProviderRoutingStore
	implements ConversationProviderRoutingStore
{
	constructor(private readonly dbOps: DatabaseOperations) {}

	getPreference(
		conversationKey: string,
	): ConversationProviderPreference | null {
		return this.dbOps.getConversationProviderPreference(conversationKey);
	}

	upsertPreference(
		conversationKey: string,
		preference: ConversationProviderPreference,
	): void {
		this.dbOps.upsertConversationProviderPreference(
			conversationKey,
			preference.provider,
			preference.promotionDeclined,
			preference.lastSeenAt,
		);
	}

	getBlock(
		conversationKey: string,
		provider: string,
	): ConversationProviderBlock | null {
		const block = this.dbOps.getConversationProviderBlock(
			conversationKey,
			provider,
		);
		if (!block) return null;
		return {
			...block,
			category: isProviderBlockCategory(block.category)
				? block.category
				: "unknown",
		};
	}

	upsertBlock(
		conversationKey: string,
		provider: string,
		block: ConversationProviderBlock,
	): void {
		this.dbOps.upsertConversationProviderBlock(
			conversationKey,
			provider,
			block.category,
			block.retryAt,
			block.lastSeenAt,
		);
	}

	deleteBlock(conversationKey: string, provider: string): void {
		this.dbOps.deleteConversationProviderBlock(conversationKey, provider);
	}
}
