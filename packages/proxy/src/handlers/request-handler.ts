import crypto from "node:crypto";
import { HttpError } from "@ccflare/http";
import { isHttpMethod, type RequestMeta } from "@ccflare/types";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

function normalizeMaxBodyBytes(maxBodyBytes: number): number {
	if (maxBodyBytes === 0) return Number.POSITIVE_INFINITY;
	return Number.isFinite(maxBodyBytes) && maxBodyBytes > 0
		? maxBodyBytes
		: DEFAULT_MAX_BODY_BYTES;
}

function bodyTooLargeError(maxBodyBytes: number): HttpError {
	return new HttpError(
		413,
		`Request body too large (maximum ${maxBodyBytes} bytes)`,
	);
}

/**
 * Creates request metadata for tracking and analytics
 * @param req - The incoming request
 * @param url - The parsed URL
 * @returns Request metadata object
 */
export function createRequestMetadata(req: Request, url: URL): RequestMeta {
	return {
		id: crypto.randomUUID(),
		method: isHttpMethod(req.method) ? req.method : "GET",
		path: url.pathname,
		timestamp: Date.now(),
	};
}

/** Extracts the requested model without reserializing or changing the body. */
export function readRequestModel(body: ArrayBuffer | null): string | undefined {
	if (!body) return undefined;
	try {
		const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return undefined;
		}
		const model = (value as Record<string, unknown>).model;
		return typeof model === "string" ? model : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Prepares request body for analytics and creates body stream factory
 * @param req - The incoming request
 * @returns Object containing the buffered body and stream factory
 */
export async function prepareRequestBody(
	req: Request,
	maxBodyBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<{
	buffer: ArrayBuffer | null;
	createStream: () => ReadableStream<Uint8Array> | undefined;
}> {
	const cap = normalizeMaxBodyBytes(maxBodyBytes);
	let buffer: ArrayBuffer | null = null;

	const contentLength = Number(req.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > cap) {
		throw bodyTooLargeError(cap);
	}

	if (req.body) {
		const reader = req.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;

			size += value.byteLength;
			if (size > cap) {
				await reader.cancel();
				throw bodyTooLargeError(cap);
			}
			chunks.push(value);
		}

		const combined = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			combined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		buffer = combined.buffer;
	}

	return {
		buffer,
		createStream: () => {
			if (!buffer) return undefined;
			return new Response(buffer).body ?? undefined;
		},
	};
}

/**
 * Makes the actual HTTP request to the provider
 * @param targetUrl - The target URL to fetch
 * @param method - HTTP method
 * @param headers - Request headers
 * @param createBodyStream - Function to create request body stream
 * @param hasBody - Whether the request has a body
 * @returns Promise resolving to the response
 */
export async function makeProxyRequest(
	targetUrl: string,
	method: string,
	headers: Headers,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	hasBody: boolean,
): Promise<Response> {
	return fetch(targetUrl, {
		method,
		headers,
		body: createBodyStream(),
		...(hasBody ? ({ duplex: "half" } as RequestInit) : {}),
	});
}
