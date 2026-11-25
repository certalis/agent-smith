import { describe, expect, it } from "bun:test";
import type { Account } from "@agent-smith/types";
import {
	getThreadBoundAccountId,
	MAX_MESSAGE_THREAD_BINDINGS,
	MESSAGE_THREAD_TTL_MS,
	rememberMessageThread,
} from "./message-thread";

const account = { id: "account-a" } as Account;
const thread = { continues: null, sessionId: "client-a" };

describe("message thread bindings", () => {
	it("expires a stale binding before it can route a continuation", () => {
		const bindings = new Map([
			[
				"msg-old",
				{
					accountId: "account-a",
					expiresAt: Date.now() - 1,
					sessionId: "client-a",
				},
			],
		]);

		expect(
			getThreadBoundAccountId(bindings, {
				continues: "msg-old",
				sessionId: "client-a",
			}),
		).toBeNull();
		expect(bindings.has("msg-old")).toBe(false);
	});

	it("bounds bindings while retaining the newest thread", () => {
		const bindings = new Map(
			Array.from({ length: MAX_MESSAGE_THREAD_BINDINGS }, (_, index) => [
				`msg-${index}`,
				{
					accountId: "account-a",
					expiresAt: Date.now() + MESSAGE_THREAD_TTL_MS,
					sessionId: "client-a",
				},
			]),
		);

		rememberMessageThread(bindings, thread, "msg-new", account);

		expect(bindings).toHaveLength(MAX_MESSAGE_THREAD_BINDINGS);
		expect(bindings.has("msg-0")).toBe(false);
		expect(bindings.get("msg-new")?.accountId).toBe("account-a");
	});
});
