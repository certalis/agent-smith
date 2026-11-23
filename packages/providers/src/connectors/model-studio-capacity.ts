import type {
	ProviderBlockCategory,
	ProviderCapacityBlock,
} from "@agent-smith/capacity";

const MAX_BLOCK_BODY_BYTES = 64 * 1024;

const MODEL_STUDIO_BLOCK_CATEGORIES: Readonly<
	Record<string, Exclude<ProviderBlockCategory, "unknown">>
> = {
	Throttling: "burst",
	"Throttling.RateQuota": "request-rate",
	"Throttling.AllocationQuota": "token-allocation",
	"Throttling.BurstRate": "burst",
	"Throttling.ResourceExhausted": "dynamic-throughput",
	"Throttling.ServiceOverloaded": "dynamic-throughput",
	ServiceUnavailable: "temporary-capacity",
};

export function retryAtFromHeader(
	response: Response,
	now: number = Date.now(),
): number | undefined {
	const retryAfter = response.headers.get("retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1_000;
	const date = Date.parse(retryAfter);
	return Number.isNaN(date) ? undefined : Math.max(now, date);
}

async function readSmallJsonBody(response: Response): Promise<unknown | null> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_BLOCK_BODY_BYTES) {
		return null;
	}
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("application/json")) return null;

	const reader = response.clone().body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_BLOCK_BODY_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}

	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

function errorCode(payload: unknown): string | undefined {
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload)
	) {
		return undefined;
	}
	const record = payload as Record<string, unknown>;
	if (typeof record.code === "string") return record.code;
	const error = record.error;
	if (typeof error !== "object" || error === null || Array.isArray(error)) {
		return undefined;
	}
	return typeof (error as Record<string, unknown>).code === "string"
		? ((error as Record<string, unknown>).code as string)
		: undefined;
}

/** Parses documented Model Studio rate-limit payloads into capacity facts. */
export async function classifyModelStudioCapacityBlock(
	response: Response,
	now: number = Date.now(),
): Promise<ProviderCapacityBlock | null> {
	if (response.status !== 429 && response.status !== 503) return null;
	const code = errorCode(await readSmallJsonBody(response));
	const category = code ? MODEL_STUDIO_BLOCK_CATEGORIES[code] : undefined;
	if (!category) {
		return response.status === 429 ? { category: "unknown" } : null;
	}
	const retryAt = retryAtFromHeader(response, now);
	return retryAt === undefined ? { category } : { category, retryAt };
}
