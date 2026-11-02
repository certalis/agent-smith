type JsonRecord = Record<string, unknown>;

type RepairPass = {
	changed: boolean;
	messages: unknown[];
};

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocks(message: unknown): unknown[] {
	return isRecord(message) && Array.isArray(message.content)
		? message.content
		: [];
}

function isThreadContinuation(value: unknown): boolean {
	return isRecord(value) && value.type === "continue";
}

function toolUseIds(message: unknown): Set<string> {
	return new Set(
		blocks(message)
			.filter(isRecord)
			.filter(
				(block) => block.type === "tool_use" && typeof block.id === "string",
			)
			.map((block) => block.id as string),
	);
}

function toolResultIds(message: unknown): Set<string> {
	return new Set(
		blocks(message)
			.filter(isRecord)
			.filter(
				(block) =>
					block.type === "tool_result" && typeof block.tool_use_id === "string",
			)
			.map((block) => block.tool_use_id as string),
	);
}

function repairPass(messages: unknown[]): RepairPass {
	let changed = false;
	const repaired = messages.flatMap((message, index) => {
		if (!isRecord(message) || !Array.isArray(message.content)) {
			return [message];
		}

		const previousUses = toolUseIds(messages[index - 1]);
		const nextResults = toolResultIds(messages[index + 1]);
		const originalBlocks = blocks(message);
		const content = originalBlocks.filter((block) => {
			if (!isRecord(block)) return true;
			if (block.type === "tool_use" && typeof block.id === "string") {
				return nextResults.has(block.id);
			}
			if (
				block.type === "tool_result" &&
				typeof block.tool_use_id === "string"
			) {
				return previousUses.has(block.tool_use_id);
			}
			return true;
		});

		if (content.length === originalBlocks.length) return [message];
		changed = true;
		if (content.length === 0) {
			return [];
		}
		return [{ ...message, content }];
	});

	return { changed, messages: repaired };
}

type ValueSpan = { end: number; start: number };

function skipWhitespace(text: string, start: number): number {
	let index = start;
	while (/\s/.test(text[index] ?? "")) index += 1;
	return index;
}

function stringEnd(text: string, start: number): number | undefined {
	if (text[start] !== '"') return undefined;
	for (let index = start + 1; index < text.length; index += 1) {
		if (text[index] === "\\") {
			index += 1;
			continue;
		}
		if (text[index] === '"') return index + 1;
	}
	return undefined;
}

function valueEnd(text: string, start: number): number | undefined {
	const valueStart = skipWhitespace(text, start);
	if (text[valueStart] === '"') return stringEnd(text, valueStart);
	if (text[valueStart] !== "{" && text[valueStart] !== "[") {
		const match = /[\s,}\]]/.exec(text.slice(valueStart));
		return match ? valueStart + match.index : text.length;
	}

	const close = text[valueStart] === "{" ? "}" : "]";
	for (let index = valueStart + 1; index < text.length; index += 1) {
		if (text[index] === '"') {
			const end = stringEnd(text, index);
			if (end === undefined) return undefined;
			index = end - 1;
			continue;
		}
		if (text[index] === close) return index + 1;
		if (text[index] === "{" || text[index] === "[") {
			const end = valueEnd(text, index);
			if (end === undefined) return undefined;
			index = end - 1;
		}
	}
	return undefined;
}

function objectPropertyValue(
	text: string,
	objectStart: number,
	key: string,
): ValueSpan | undefined {
	if (text[objectStart] !== "{") return undefined;
	let index = skipWhitespace(text, objectStart + 1);
	while (text[index] !== "}") {
		const keyEnd = stringEnd(text, index);
		if (keyEnd === undefined) return undefined;
		let valueStart = skipWhitespace(text, keyEnd);
		if (text[valueStart] !== ":") return undefined;
		valueStart = skipWhitespace(text, valueStart + 1);
		const end = valueEnd(text, valueStart);
		if (end === undefined) return undefined;
		if (JSON.parse(text.slice(index, keyEnd)) === key) {
			return { end, start: valueStart };
		}
		index = skipWhitespace(text, end);
		if (text[index] === ",") index = skipWhitespace(text, index + 1);
		else if (text[index] !== "}") return undefined;
	}
	return undefined;
}

/**
 * Replaces only the account UUID embedded in metadata.user_id. The UUID is a
 * fixed-length token, so the surrounding wire bytes and body length are kept.
 */
export function patchAccountUuid(
	body: ArrayBuffer,
	accountUuid: string | null | undefined,
): ArrayBuffer {
	const targetUuid = accountUuid ?? "";
	if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(targetUuid)) {
		return body;
	}

	const text = new TextDecoder().decode(body);
	const root = skipWhitespace(text, 0);
	const metadata = objectPropertyValue(text, root, "metadata");
	if (!metadata || text[metadata.start] !== "{") return body;
	const userId = objectPropertyValue(text, metadata.start, "user_id");
	if (!userId || text[userId.start] !== '"') return body;

	let encodedUserId: unknown;
	let decodedUserId: unknown;
	try {
		encodedUserId = JSON.parse(text.slice(userId.start, userId.end));
		decodedUserId =
			typeof encodedUserId === "string" ? JSON.parse(encodedUserId) : undefined;
	} catch {
		return body;
	}
	if (
		!isRecord(decodedUserId) ||
		typeof decodedUserId.account_uuid !== "string"
	) {
		return body;
	}
	const currentUuid = decodedUserId.account_uuid;
	if (currentUuid === targetUuid || currentUuid.length !== targetUuid.length) {
		return body;
	}

	const rawUserId = text.slice(userId.start, userId.end);
	const keyStart = rawUserId.indexOf('\\"account_uuid\\"');
	const valueStart = rawUserId.indexOf(currentUuid, keyStart);
	if (keyStart === -1 || valueStart === -1) return body;
	const uuidStart = userId.start + valueStart;
	return new TextEncoder().encode(
		`${text.slice(0, uuidStart)}${targetUuid}${text.slice(uuidStart + currentUuid.length)}`,
	).buffer;
}

function patchModel(body: ArrayBuffer, model: string | undefined): ArrayBuffer {
	if (model === undefined) return body;
	const text = new TextDecoder().decode(body);
	const root = skipWhitespace(text, 0);
	const value = objectPropertyValue(text, root, "model");
	if (!value || text[value.start] !== '"') return body;
	let current: unknown;
	try {
		current = JSON.parse(text.slice(value.start, value.end));
	} catch {
		return body;
	}
	if (current === model) return body;
	return new TextEncoder().encode(
		`${text.slice(0, value.start)}${JSON.stringify(model)}${text.slice(value.end)}`,
	).buffer;
}

export function rewriteRequestBody(
	body: ArrayBuffer,
	accountUuid: string | null | undefined,
	path: string,
	contentType: string | null,
	model?: string,
): ArrayBuffer {
	const repaired = dropOrphanedToolPairs(body, path, contentType);
	const accountPatched = path.startsWith("/v1/messages")
		? patchAccountUuid(repaired, accountUuid)
		: repaired;
	return patchModel(accountPatched, model);
}

/**
 * Repairs only tool blocks that lack their adjacent counterpart. Bodies that
 * already obey the upstream rule are returned as their original bytes.
 */
export function dropOrphanedToolPairs(
	body: ArrayBuffer,
	path: string,
	contentType: string | null,
): ArrayBuffer {
	if (
		!path.startsWith("/v1/messages") ||
		!contentType?.includes("application/json")
	) {
		return body;
	}

	const text = new TextDecoder().decode(body);
	let parsed: JsonRecord;
	try {
		const decoded = JSON.parse(text) as unknown;
		if (!isRecord(decoded)) return body;
		parsed = decoded;
	} catch {
		return body;
	}
	if (!Array.isArray(parsed.messages) || isThreadContinuation(parsed.thread)) {
		return body;
	}

	let messages: unknown[] = parsed.messages;
	let changed = false;
	while (true) {
		const pass = repairPass(messages);
		messages = pass.messages;
		changed ||= pass.changed;

		if (!pass.changed) break;
	}

	if (!changed) return body;
	return new TextEncoder().encode(JSON.stringify({ ...parsed, messages }))
		.buffer;
}
