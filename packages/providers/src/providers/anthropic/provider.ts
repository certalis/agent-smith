import { BUFFER_SIZES } from "@agent-smith/core";
import {
	type Account,
	type AccountQuotaState,
	getProviderDefaultBaseUrl,
	isRecord,
} from "@agent-smith/types";
import {
	BaseProvider,
	deleteClientCredentialHeaders,
	deleteTransportHeaders,
} from "../../base";
import type { RateLimitInfo } from "../../types";

// Hard rate limit statuses that should block account usage
const HARD_LIMIT_STATUSES = new Set([
	"rate_limited",
	"rejected",
	"blocked",
	"queueing_hard",
	"payment_required",
]);

// Soft warning statuses that should not block account usage
const _SOFT_WARNING_STATUSES = new Set(["allowed_warning", "queueing_soft"]);
const PROVIDER_NAME = "anthropic" as const;
const DEFAULT_BASE_URL = getProviderDefaultBaseUrl(PROVIDER_NAME);

const QUOTA_BUCKETS = {
	unified5h: "5h",
	unified7d: "7d",
	unified7dFable: "7d_oi",
	unified7dOpus: "7d_opus",
	unified7dSonnet: "7d_sonnet",
} as const;
const SHARED_QUOTA_BUCKETS = ["unified", "unified5h", "unified7d"];

function familyQuotaBucket(model: string | undefined): string | undefined {
	const normalized = model?.toLowerCase();
	if (!normalized) return undefined;
	if (normalized.includes("fable")) return "unified7dFable";
	if (normalized.includes("opus")) return "unified7dOpus";
	if (normalized.includes("sonnet")) return "unified7dSonnet";
	return undefined;
}

function parseQuotaNumber(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseQuotaBoolean(value: string | null): boolean | null {
	if (value === null) return null;
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	return null;
}

function parseQuotaState(response: Response): AccountQuotaState | undefined {
	const windows: AccountQuotaState["windows"] = {};
	const seenAt = Date.now();
	for (const [name, headerName] of Object.entries(QUOTA_BUCKETS)) {
		const prefix = `anthropic-ratelimit-unified-${headerName}`;
		const status = response.headers.get(`${prefix}-status`);
		const utilization = parseQuotaNumber(
			response.headers.get(`${prefix}-utilization`),
		);
		const resetSeconds = parseQuotaNumber(
			response.headers.get(`${prefix}-reset`),
		);
		if (status === null && utilization === null && resetSeconds === null)
			continue;
		windows[name] = {
			resetAt: resetSeconds === null ? null : resetSeconds * 1000,
			seenAt,
			status,
			utilization,
		};
	}

	const status = response.headers.get("anthropic-ratelimit-unified-status");
	const resetSeconds = parseQuotaNumber(
		response.headers.get("anthropic-ratelimit-unified-reset"),
	);
	const sharedStatus =
		[windows.unified5h?.status, windows.unified7d?.status].find(
			(value) => value === "rejected",
		) ??
		windows.unified5h?.status ??
		windows.unified7d?.status ??
		status;
	if (status !== null || resetSeconds !== null) {
		windows.unified = {
			resetAt: resetSeconds === null ? null : resetSeconds * 1000,
			seenAt,
			status: sharedStatus ?? null,
			utilization: null,
		};
	}

	const representativeClaim = response.headers.get(
		"anthropic-ratelimit-unified-representative-claim",
	);
	const fallbackPercentage = parseQuotaNumber(
		response.headers.get("anthropic-ratelimit-unified-fallback-percentage"),
	);
	const overageStatus = response.headers.get(
		"anthropic-ratelimit-unified-overage-status",
	);
	const overageReset = parseQuotaNumber(
		response.headers.get("anthropic-ratelimit-unified-overage-reset"),
	);
	const overageUtilization = parseQuotaNumber(
		response.headers.get("anthropic-ratelimit-unified-overage-utilization"),
	);
	const overageSurpassedThreshold = parseQuotaBoolean(
		response.headers.get(
			"anthropic-ratelimit-unified-overage-surpassed-threshold",
		),
	);
	const overageSeen =
		overageStatus !== null ||
		overageReset !== null ||
		overageUtilization !== null ||
		overageSurpassedThreshold !== null;

	if (
		Object.keys(windows).length === 0 &&
		representativeClaim === null &&
		fallbackPercentage === null &&
		!overageSeen
	) {
		return undefined;
	}

	return {
		windows,
		...(representativeClaim !== null && { representativeClaim }),
		...(fallbackPercentage !== null && { fallbackPercentage }),
		...(overageSeen && {
			overage: {
				resetAt: overageReset === null ? null : overageReset * 1000,
				seenAt,
				status: overageStatus,
				utilization: overageUtilization,
				surpassedThreshold: overageSurpassedThreshold,
			},
		}),
	};
}

function parseAnthropicUsage(value: unknown):
	| {
			input_tokens?: number;
			output_tokens?: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
	  }
	| undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const parsedUsage = {
		...(typeof value.input_tokens === "number" && {
			input_tokens: value.input_tokens,
		}),
		...(typeof value.output_tokens === "number" && {
			output_tokens: value.output_tokens,
		}),
		...(typeof value.cache_creation_input_tokens === "number" && {
			cache_creation_input_tokens: value.cache_creation_input_tokens,
		}),
		...(typeof value.cache_read_input_tokens === "number" && {
			cache_read_input_tokens: value.cache_read_input_tokens,
		}),
	};

	return Object.keys(parsedUsage).length > 0 ? parsedUsage : undefined;
}

function parseAnthropicMessageEnvelope(value: unknown): {
	message?: {
		model?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
	};
} | null {
	if (!isRecord(value)) {
		return null;
	}

	const usage = parseAnthropicUsage(
		value.message && isRecord(value.message) ? value.message.usage : undefined,
	);
	return {
		...(isRecord(value.message) && {
			message: {
				...(typeof value.message.model === "string" && {
					model: value.message.model,
				}),
				...(usage && { usage }),
			},
		}),
	};
}

export class AnthropicProvider extends BaseProvider {
	name: string = PROVIDER_NAME;
	defaultBaseUrl: string = DEFAULT_BASE_URL;
	wire = "anthropic-messages" as const;

	async isQuotaRejection(response: Response): Promise<boolean> {
		return (
			response.status === 429 &&
			[...response.headers.entries()].some(
				([name, value]) =>
					name.startsWith("anthropic-ratelimit-unified-") &&
					name.endsWith("-status") &&
					value === "rejected",
			)
		);
	}

	hasRateLimitSignal(headerName: string): boolean {
		return (
			super.hasRateLimitSignal(headerName) ||
			headerName.toLowerCase().startsWith("anthropic-ratelimit-unified-")
		);
	}

	/** The rule Claude Code itself applies: a served "rejected" with overage allowed is extra usage. */
	spendsExtraUsage(response: Response): boolean {
		if (!response.ok) return false;
		const overageStatus = response.headers.get(
			"anthropic-ratelimit-unified-overage-status",
		);
		return (
			response.headers.get("anthropic-ratelimit-unified-overage-in-use") ===
				"true" ||
			(response.headers.get("anthropic-ratelimit-unified-status") ===
				"rejected" &&
				(overageStatus === "allowed" || overageStatus === "allowed_warning"))
		);
	}

	quotaBucketsFor(model: string | undefined): readonly string[] {
		const familyBucket = familyQuotaBucket(model);
		return familyBucket
			? [...SHARED_QUOTA_BUCKETS, familyBucket]
			: SHARED_QUOTA_BUCKETS;
	}

	weeklyBucketFor(model: string | undefined): string {
		return familyQuotaBucket(model) ?? "unified7d";
	}

	isWeeklyBucket(bucket: string): boolean {
		return bucket.startsWith("unified7d");
	}

	isFiveHourBucket(bucket: string): boolean {
		return bucket === "unified5h";
	}

	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const newHeaders = new Headers(headers);
		deleteClientCredentialHeaders(newHeaders);

		if (account?.api_key) {
			newHeaders.set("x-api-key", account.api_key);
		}

		deleteTransportHeaders(newHeaders);

		return newHeaders;
	}

	parseRateLimit(response: Response): RateLimitInfo {
		const quotaState = parseQuotaState(response);
		// Check for unified rate limit headers
		const statusHeader = response.headers.get(
			"anthropic-ratelimit-unified-status",
		);
		const resetHeader = response.headers.get(
			"anthropic-ratelimit-unified-reset",
		);
		const remainingHeader = response.headers.get(
			"anthropic-ratelimit-unified-remaining",
		);
		const effectiveStatus = quotaState?.windows.unified?.status ?? statusHeader;

		if (statusHeader || resetHeader) {
			const resetTime = resetHeader ? Number(resetHeader) * 1000 : undefined; // Convert to ms
			const remaining = remainingHeader ? Number(remainingHeader) : undefined;

			// Only mark as rate limited for hard limit statuses or 429
			const isRateLimited =
				HARD_LIMIT_STATUSES.has(effectiveStatus || "") ||
				response.status === 429;

			return {
				isRateLimited,
				resetTime,
				statusHeader: statusHeader || undefined,
				remaining,
				quotaState,
			};
		}

		// Fall back to 429 status with x-ratelimit-reset header
		if (response.status !== 429) {
			return { isRateLimited: false, quotaState };
		}

		const rateLimitReset = response.headers.get("x-ratelimit-reset");
		const retryAfter = response.headers.get("retry-after");
		const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
		const resetTime = rateLimitReset
			? parseInt(rateLimitReset, 10) * 1000
			: Number.isFinite(retryAfterSeconds)
				? Date.now() + Math.max(0, retryAfterSeconds) * 1000
				: Date.now() + 60000; // Default to 1 minute

		return {
			isRateLimited: true,
			resetTime,
			quotaState,
		};
	}

	async extractUsageInfo(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null> {
		try {
			const clone = response.clone();
			const contentType = response.headers.get("content-type");

			// Handle streaming responses (SSE)
			if (contentType?.includes("text/event-stream")) {
				// Use bounded reader to avoid consuming entire stream
				const reader = clone.body?.getReader();
				if (!reader) return null;

				let buffered = "";
				const maxBytes = BUFFER_SIZES.ANTHROPIC_STREAM_CAP_BYTES;
				const decoder = new TextDecoder();
				let foundMessageStart = false;

				try {
					while (buffered.length < maxBytes) {
						const { value, done } = await reader.read();
						if (done) break;

						buffered += decoder.decode(value, { stream: true });

						// Check if we have the message_start event
						if (buffered.includes("event: message_start")) {
							foundMessageStart = true;
							// Read a bit more to ensure we get the data line
							const { value: nextValue, done: nextDone } = await reader.read();
							if (!nextDone && nextValue) {
								buffered += decoder.decode(nextValue, { stream: true });
							}
							break;
						}
					}
				} finally {
					// Cancel the reader to prevent hanging
					reader.cancel().catch(() => {});
				}

				if (!foundMessageStart) return null;

				// Parse the buffered content
				const lines = buffered.split("\n");

				// Parse SSE events
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (line.startsWith("event: message_start")) {
						// Next line should be the data
						const dataLine = lines[i + 1];
						if (dataLine?.startsWith("data: ")) {
							try {
								const jsonStr = dataLine.slice(6); // Remove "data: " prefix
								const data = parseAnthropicMessageEnvelope(JSON.parse(jsonStr));

								if (data?.message?.usage) {
									const usage = data.message.usage;
									const inputTokens = usage.input_tokens ?? 0;
									const cacheCreationInputTokens =
										usage.cache_creation_input_tokens ?? 0;
									const cacheReadInputTokens =
										usage.cache_read_input_tokens ?? 0;
									const outputTokens = usage.output_tokens ?? 0;
									const promptTokens =
										inputTokens +
										cacheCreationInputTokens +
										cacheReadInputTokens;
									const completionTokens = outputTokens;
									const totalTokens = promptTokens + completionTokens;

									// Extract cost from header if available
									const costHeader = response.headers.get(
										"anthropic-billing-cost",
									);
									const costUsd = costHeader
										? parseFloat(costHeader)
										: undefined;

									return {
										model: data.message.model,
										promptTokens,
										completionTokens,
										totalTokens,
										costUsd,
										inputTokens,
										cacheReadInputTokens,
										cacheCreationInputTokens,
										outputTokens,
									};
								}
							} catch {
								// Ignore parse errors
							}
						}
					}
				}

				// For streaming responses, we only extract initial usage
				// Output tokens will be accumulated during streaming but we can't capture that here
				return null;
			} else {
				// Handle non-streaming JSON responses
				const rawJson = await clone.json();
				const json = isRecord(rawJson)
					? {
							model:
								typeof rawJson.model === "string" ? rawJson.model : undefined,
							usage: parseAnthropicUsage(rawJson.usage),
						}
					: null;

				if (!json?.usage) return null;

				const inputTokens = json.usage.input_tokens ?? 0;
				const cacheCreationInputTokens =
					json.usage.cache_creation_input_tokens ?? 0;
				const cacheReadInputTokens = json.usage.cache_read_input_tokens ?? 0;
				const outputTokens = json.usage.output_tokens ?? 0;
				const promptTokens =
					inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
				const completionTokens = outputTokens;
				const totalTokens = promptTokens + completionTokens;

				// Extract cost from header if available
				const costHeader = response.headers.get("anthropic-billing-cost");
				const costUsd = costHeader ? parseFloat(costHeader) : undefined;

				return {
					model: json.model,
					promptTokens,
					completionTokens,
					totalTokens,
					costUsd,
					inputTokens,
					cacheReadInputTokens,
					cacheCreationInputTokens,
					outputTokens,
				};
			}
		} catch {
			// Ignore parsing errors
			return null;
		}
	}
}
