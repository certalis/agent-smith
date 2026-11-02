import { BaseRepository } from "./base.repository";

export type ConversationPin = {
	accountId: string;
	lastSeenAt: number;
};

export class ConversationPinRepository extends BaseRepository<ConversationPin> {
	find(pinKey: string): ConversationPin | null {
		const row = this.get<{ account_id: string; last_seen_at: number }>(
			`SELECT account_id, last_seen_at FROM conversation_pins WHERE pin_key = ?`,
			[pinKey],
		);
		return row
			? { accountId: row.account_id, lastSeenAt: row.last_seen_at }
			: null;
	}

	upsert(pinKey: string, accountId: string, lastSeenAt: number): void {
		this.run(
			`
				INSERT INTO conversation_pins (pin_key, account_id, last_seen_at)
				VALUES (?, ?, ?)
				ON CONFLICT(pin_key) DO UPDATE SET
					account_id = excluded.account_id,
					last_seen_at = excluded.last_seen_at
			`,
			[pinKey, accountId, lastSeenAt],
		);
	}

	countByAccount(activeSince: number): Map<string, number> {
		const rows = this.query<{ account_id: string; count: number }>(
			`
				SELECT account_id, COUNT(*) AS count
				FROM conversation_pins
				WHERE last_seen_at >= ?
				GROUP BY account_id
			`,
			[activeSince],
		);
		return new Map(rows.map((row) => [row.account_id, row.count]));
	}

	deleteExpired(before: number): void {
		this.run(`DELETE FROM conversation_pins WHERE last_seen_at < ?`, [before]);
	}

	deleteForAccount(accountId: string): void {
		this.run(`DELETE FROM conversation_pins WHERE account_id = ?`, [accountId]);
	}
}
