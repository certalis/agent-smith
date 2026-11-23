import { BaseRepository } from "./base.repository";

export type ConversationProviderPreference = {
	provider: string;
	promotionDeclined: boolean;
	lastSeenAt: number;
};

export class ConversationProviderPreferenceRepository extends BaseRepository<ConversationProviderPreference> {
	find(pinKey: string): ConversationProviderPreference | null {
		const row = this.get<{
			provider: string;
			promotion_declined: 0 | 1;
			last_seen_at: number;
		}>(
			`SELECT provider, promotion_declined, last_seen_at FROM conversation_provider_preferences WHERE pin_key = ?`,
			[pinKey],
		);
		return row
			? {
					provider: row.provider,
					promotionDeclined: row.promotion_declined === 1,
					lastSeenAt: row.last_seen_at,
				}
			: null;
	}

	upsert(
		pinKey: string,
		provider: string,
		promotionDeclined: boolean,
		lastSeenAt: number,
	): void {
		this.run(
			`
				INSERT INTO conversation_provider_preferences (
					pin_key, provider, promotion_declined, last_seen_at
				)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(pin_key) DO UPDATE SET
					provider = excluded.provider,
					promotion_declined = excluded.promotion_declined,
					last_seen_at = excluded.last_seen_at
			`,
			[pinKey, provider, promotionDeclined ? 1 : 0, lastSeenAt],
		);
	}

	deleteExpired(before: number): void {
		this.run(
			`DELETE FROM conversation_provider_preferences WHERE last_seen_at < ?`,
			[before],
		);
	}

	deleteForAccount(accountId: string): void {
		this.run(
			`
				DELETE FROM conversation_provider_preferences
				WHERE pin_key IN (
					SELECT pin_key FROM conversation_pins WHERE account_id = ?
				)
			`,
			[accountId],
		);
	}
}
