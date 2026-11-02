const MAX_STREAM_HEAD_BYTES = 256 * 1024;
const STREAM_HEAD_TIMEOUT_MS = 10_000;

const RETRYABLE_FAILURE_CODES = new Set([
	"overloaded_error",
	"rate_limit_exceeded",
	"server_error",
	"server_is_overloaded",
]);

type StreamHeadVerdict = "failure" | "output" | "pending";
type PendingRead = Promise<{ done: boolean; value?: Uint8Array }>;

export type StreamHeadInspection = {
	discard?: () => Promise<void>;
	failure: boolean;
	messageId?: string;
	response: Response;
};

export type StreamHeadOptions = {
	maxBytes?: number;
	sleep?: (milliseconds: number) => Promise<unknown>;
	timeoutMs?: number;
};

type StreamHeadDeadline = {
	cancel: () => void;
	expires: Promise<undefined>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failureCode(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.code === "string") return value.code;
	if (typeof value.type === "string") return value.type;
	return undefined;
}

function eventVerdict(frame: string): {
	messageId?: string;
	verdict: StreamHeadVerdict;
} {
	const data = frame
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trimStart())
		.join("\n");
	if (!data) return { verdict: "pending" };

	let event: unknown;
	try {
		event = JSON.parse(data);
	} catch {
		return { verdict: "pending" };
	}
	if (!isRecord(event)) return { verdict: "pending" };

	const nestedError = isRecord(event.response)
		? event.response.error
		: undefined;
	const code = failureCode(event.error) ?? failureCode(nestedError);
	if (code && RETRYABLE_FAILURE_CODES.has(code)) return { verdict: "failure" };

	const messageId =
		isRecord(event.message) && typeof event.message.id === "string"
			? event.message.id
			: undefined;

	if (
		event.type === "content_block_delta" ||
		event.type === "message_start" ||
		event.type === "response.created" ||
		event.type === "response.completed" ||
		event.type === "response.output_text.delta"
	) {
		return { messageId, verdict: "output" };
	}

	return { messageId, verdict: "pending" };
}

function replayBody(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	initial: Uint8Array[],
	pending?: PendingRead,
): ReadableStream<Uint8Array> {
	const buffered = [...initial];
	let nextRead = pending;

	return new ReadableStream({
		async pull(controller) {
			const chunk = buffered.shift();
			if (chunk) {
				controller.enqueue(chunk);
				return;
			}

			const result = nextRead ? await nextRead : await reader.read();
			nextRead = undefined;
			if (result.done) {
				controller.close();
				return;
			}
			if (result.value) {
				controller.enqueue(result.value);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

function replayResponse(
	response: Response,
	reader: ReadableStreamDefaultReader<Uint8Array>,
	initial: Uint8Array[],
	pending?: PendingRead,
): Response {
	return new Response(replayBody(reader, initial, pending), {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
}

function streamHeadDeadline(options: StreamHeadOptions): StreamHeadDeadline {
	const timeoutMs = options.timeoutMs ?? STREAM_HEAD_TIMEOUT_MS;
	if (options.sleep) {
		return {
			cancel: () => undefined,
			expires: options.sleep(timeoutMs).then(() => undefined),
		};
	}
	let cancel: () => void = () => {};
	return {
		cancel: () => cancel(),
		expires: new Promise((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			cancel = () => clearTimeout(timer);
		}),
	};
}

/**
 * Reads a bounded SSE head before headers are exposed and replays those bytes
 * ahead of the untouched remainder. This lets routing inspect the first event
 * without buffering or truncating a normal client stream.
 */
export async function inspectStreamHead(
	response: Response,
	isStream: boolean,
	options: StreamHeadOptions = {},
): Promise<StreamHeadInspection> {
	if (!isStream || !response.body) return { failure: false, response };

	const maxBytes = options.maxBytes ?? MAX_STREAM_HEAD_BYTES;
	const deadline = streamHeadDeadline(options);
	const reader = response.body.getReader();
	const inspected: Uint8Array[] = [];
	let bytesRead = 0;
	let buffered = "";
	const decoder = new TextDecoder();

	try {
		while (bytesRead < maxBytes) {
			const read = reader.read();
			const result = await Promise.race([read, deadline.expires]);
			if (!result) {
				return {
					failure: false,
					response: replayResponse(response, reader, inspected, read),
				};
			}
			if (result.done) {
				return {
					failure: false,
					response: replayResponse(response, reader, inspected),
				};
			}

			inspected.push(result.value);
			const inspectedLength = Math.min(
				result.value.byteLength,
				maxBytes - bytesRead,
			);
			bytesRead += inspectedLength;
			buffered += decoder
				.decode(result.value.subarray(0, inspectedLength), { stream: true })
				.replaceAll("\r\n", "\n");

			let delimiter = buffered.indexOf("\n\n");
			while (delimiter !== -1) {
				const inspection = eventVerdict(buffered.slice(0, delimiter));
				if (inspection.verdict !== "pending") {
					return {
						discard: () => reader.cancel("retrying on a sibling account"),
						failure: inspection.verdict === "failure",
						messageId: inspection.messageId,
						response: replayResponse(response, reader, inspected),
					};
				}
				buffered = buffered.slice(delimiter + 2);
				delimiter = buffered.indexOf("\n\n");
			}
			if (inspectedLength < result.value.byteLength) {
				return {
					failure: false,
					response: replayResponse(response, reader, inspected),
				};
			}
		}

		return {
			failure: false,
			response: replayResponse(response, reader, inspected),
		};
	} finally {
		deadline.cancel();
	}
}
