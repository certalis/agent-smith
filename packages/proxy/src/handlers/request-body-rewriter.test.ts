import { describe, expect, it } from "bun:test";
import {
	dropOrphanedToolPairs,
	patchAccountUuid,
	rewriteRequestBody,
} from "./request-body-rewriter";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function body(value: unknown): ArrayBuffer {
	return encoder.encode(JSON.stringify(value)).buffer;
}

function json(value: ArrayBuffer): Record<string, unknown> {
	return JSON.parse(decoder.decode(value)) as Record<string, unknown>;
}

describe("dropOrphanedToolPairs", () => {
	// Case table:
	// 1 | Unit | a removal exposes another orphan without altering neighbours | red
	// 2 | Unit | a thread continuation is forwarded byte-for-byte             | red
	it("repairs cascaded orphaned pairs without altering same-role neighbours", () => {
		const original = body({
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "toolu_A" }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "toolu_A" }],
				},
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "toolu_B" }],
				},
				{ role: "user", content: "chatter" },
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "toolu_B" }],
				},
			],
		});

		const result = json(
			dropOrphanedToolPairs(original, "/v1/messages", "application/json"),
		);
		const messages = result.messages as Array<{ role: string }>;

		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"user",
		]);
		expect(JSON.stringify(result)).toContain("toolu_A");
		expect(JSON.stringify(result)).not.toContain("toolu_B");
	});

	it("preserves a thread continuation byte-for-byte", () => {
		const original = body({
			thread: { type: "continue", previous_message_id: "msg_previous" },
			messages: [
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "toolu_thread" }],
				},
				{ role: "system", content: [{ type: "text", text: "reminder" }] },
			],
		});

		expect(
			dropOrphanedToolPairs(original, "/v1/messages", "application/json"),
		).toBe(original);
	});

	it("patches only metadata.user_id.account_uuid without changing body length", () => {
		const oldUuid = "11111111-2222-3333-4444-555555555555";
		const newUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const original = body({
			messages: [
				{
					role: "user",
					content: `leave this account_uuid alone: ${oldUuid}`,
				},
			],
			metadata: {
				user_id: JSON.stringify({ account_uuid: oldUuid, device_id: "device" }),
			},
		});

		const patched = patchAccountUuid(original, newUuid);
		const parsed = json(patched);

		expect(patched.byteLength).toBe(original.byteLength);
		expect(
			JSON.parse((parsed.metadata as { user_id: string }).user_id),
		).toEqual(expect.objectContaining({ account_uuid: newUuid }));
		expect(JSON.stringify(parsed.messages)).toContain(oldUuid);
	});
});

describe("rewriteRequestBody model mapping", () => {
	it("patches only the root model string without reserializing the request", () => {
		const original = encoder.encode(
			'{"model":"claude-sonnet-4-5","messages":[],"note":"model"}',
		).buffer;

		expect(
			decoder.decode(
				rewriteRequestBody(
					original,
					null,
					"/v1/messages",
					"application/json",
					"acme-sonnet",
				),
			),
		).toBe('{"model":"acme-sonnet","messages":[],"note":"model"}');
	});

	it("keeps byte-identical bodies when no model mapping applies", () => {
		const original = encoder.encode(
			'{"model":"claude-sonnet-4-5","messages":[]}',
		).buffer;

		expect(
			rewriteRequestBody(
				original,
				null,
				"/v1/messages",
				"application/json",
				undefined,
			),
		).toBe(original);
	});
});
