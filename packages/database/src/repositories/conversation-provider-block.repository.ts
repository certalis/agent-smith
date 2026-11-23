import { BaseRepository } from "./base.repository";

export type ConversationProviderBlock = {
	category: string;
	lastSeenAt: number;
	retryAt: number | undefined;
};

/** Records an upstream provider limit without claiming it has cleared. */
export class ConversationProviderBlockRepository extends BaseRepository<ConversationProviderBlock> {
	find(pinKey: string, provider: string): ConversationProviderBlock | null {
		const row = this.get<{
			category: string;
			last_seen_at: number;
			retry_at: number | null;
		}>(
			`SELECT category, retry_at, last_seen_at FROM conversation_provider_blocks WHERE pin_key = ? AND provider = ?`,
			[pinKey, provider],
		);
		return row
			? {
					category: row.category,
					lastSeenAt: row.last_seen_at,
					retryAt: row.retry_at ?? undefined,
				}
			: null;
	}

	upsert(
		pinKey: string,
		provider: string,
		category: string,
		retryAt: number | undefined,
		lastSeenAt: number,
	): void {
		this.run(
			`
				INSERT INTO conversation_provider_blocks (
					pin_key, provider, category, retry_at, last_seen_at
				)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(pin_key, provider) DO UPDATE SET
					category = excluded.category,
					retry_at = excluded.retry_at,
					last_seen_at = excluded.last_seen_at
			`,
			[pinKey, provider, category, retryAt ?? null, lastSeenAt],
		);
	}

	delete(pinKey: string, provider: string): void {
		this.run(
			`DELETE FROM conversation_provider_blocks WHERE pin_key = ? AND provider = ?`,
			[pinKey, provider],
		);
	}

	deleteExpired(before: number): void {
		this.run(
			`DELETE FROM conversation_provider_blocks WHERE last_seen_at < ?`,
			[before],
		);
	}

	deleteForAccount(accountId: string): void {
		this.run(
			`
				DELETE FROM conversation_provider_blocks
				WHERE pin_key IN (
					SELECT pin_key FROM conversation_pins WHERE account_id = ?
				)
			`,
			[accountId],
		);
	}
}
