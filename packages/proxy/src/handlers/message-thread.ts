import type { Account } from "@ccflare/types";

export type MessageThreadRequest = {
	continues: string | null;
	sessionId: string;
};

export type MessageThreadBinding = {
	accountId: string;
	expiresAt: number;
	sessionId: string;
};

export const MESSAGE_THREAD_TTL_MS = 60 * 60_000;
export const MAX_MESSAGE_THREAD_BINDINGS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Identifies Claude Code's explicit message-thread protocol. It intentionally
 * ignores malformed bodies and requests without a client session: neither can
 * safely claim another session's upstream thread.
 */
export function parseMessageThreadRequest(
	body: ArrayBuffer | null,
	upstreamPath: string,
	contentType: string | null,
	sessionId: string | null,
): MessageThreadRequest | null {
	if (
		!body ||
		upstreamPath !== "/v1/messages" ||
		!contentType?.includes("application/json") ||
		!sessionId
	) {
		return null;
	}

	try {
		const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.thread)) return null;
		if (parsed.thread.type !== "create" && parsed.thread.type !== "continue") {
			return null;
		}
		return {
			continues:
				typeof parsed.thread.previous_message_id === "string"
					? parsed.thread.previous_message_id
					: null,
			sessionId,
		};
	} catch {
		return null;
	}
}

export function getThreadBoundAccountId(
	bindings: Map<string, MessageThreadBinding> | undefined,
	thread: MessageThreadRequest | null,
): string | null {
	if (!bindings || !thread?.continues) return null;
	const binding = bindings.get(thread.continues);
	if (binding && binding.expiresAt <= Date.now()) {
		bindings.delete(thread.continues);
		return null;
	}
	return binding?.sessionId === thread.sessionId ? binding.accountId : null;
}

function pruneExpiredBindings(
	bindings: Map<string, MessageThreadBinding>,
): void {
	const now = Date.now();
	for (const [messageId, binding] of bindings) {
		if (binding.expiresAt <= now) bindings.delete(messageId);
	}
	while (bindings.size >= MAX_MESSAGE_THREAD_BINDINGS) {
		const oldest = bindings.keys().next().value;
		if (!oldest) break;
		bindings.delete(oldest);
	}
}

export function rememberMessageThread(
	bindings: Map<string, MessageThreadBinding> | undefined,
	thread: MessageThreadRequest | null,
	messageId: string | null,
	account: Account,
): void {
	if (!bindings || !thread || !messageId) return;
	pruneExpiredBindings(bindings);
	bindings.set(messageId, {
		accountId: account.id,
		expiresAt: Date.now() + MESSAGE_THREAD_TTL_MS,
		sessionId: thread.sessionId,
	});
}

export async function readMessageId(
	response: Response,
): Promise<string | null> {
	if (!response.headers.get("content-type")?.includes("application/json")) {
		return null;
	}

	try {
		const value = (await response.clone().json()) as unknown;
		return isRecord(value) && typeof value.id === "string" ? value.id : null;
	} catch {
		return null;
	}
}
