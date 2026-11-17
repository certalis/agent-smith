import type { ResetCreditRequest } from "@agent-smith/types";

type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const key = (accountId: string) => `agent-smith:pending-reset:${accountId}`;

export function loadResetAttempt(
	storage: AttemptStorage,
	accountId: string,
): ResetCreditRequest | null {
	const text = storage.getItem(key(accountId));
	if (text === null) return null;
	const value = JSON.parse(text) as Partial<ResetCreditRequest>;
	if (typeof value.creditId !== "string" || typeof value.requestId !== "string")
		throw new Error(
			"Invalid pending reset; check its outcome before using another",
		);
	return { creditId: value.creditId, requestId: value.requestId };
}

export function beginResetAttempt(
	storage: AttemptStorage,
	accountId: string,
	creditId: string,
): ResetCreditRequest {
	const pending = loadResetAttempt(storage, accountId);
	if (pending && pending.creditId !== creditId)
		throw new Error("Resolve the pending reset first");
	const attempt = pending ?? { creditId, requestId: crypto.randomUUID() };
	storage.setItem(key(accountId), JSON.stringify(attempt));
	return attempt;
}

export function completeResetAttempt(
	storage: AttemptStorage,
	accountId: string,
): void {
	storage.removeItem(key(accountId));
}
