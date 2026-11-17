import type { AccountResponse } from "@agent-smith/api";
import { HttpClient, HttpError, type RequestOptions } from "@agent-smith/http";
import type {
	AccountCreateData,
	AccountProvider,
	AnalyticsResponse,
	ApiKeyProvider,
	AuthCompleteData,
	AuthInitData,
	AuthSessionStatusResponse,
	CallerUsageResponse,
	CleanupResponse,
	LogEvent,
	ManualResetResult,
	MutationResult,
	OAuthProvider,
	RequestPayload,
	RequestSummary,
	ResetCreditRequest,
	ResetCredits,
	RetentionGetResponse,
	RetentionSetRequest,
	StatsWithAccounts,
	StrategyName,
	StrategyResponse,
	TimeRange,
} from "@agent-smith/types";
import { isLogEvent, parseLogStreamEvent } from "@agent-smith/types";
import { API_LIMITS, API_TIMEOUT } from "./constants";

class API extends HttpClient {
	private adminKey: string | undefined;
	private adminKeyRevision = 0;
	private adminKeyListeners = new Set<() => void>();
	getAdminKeyRevision = () => this.adminKeyRevision;
	hasAdminKey = () => Boolean(this.adminKey);
	subscribeAdminKey = (listener: () => void) => {
		this.adminKeyListeners.add(listener);
		return () => {
			this.adminKeyListeners.delete(listener);
		};
	};
	private adminKeyChanged(): void {
		this.adminKeyRevision++;
		for (const listener of this.adminKeyListeners) listener();
	}

	constructor() {
		super({
			baseUrl: "",
			defaultHeaders: {
				"Content-Type": "application/json",
			},
			timeout: API_TIMEOUT,
			retries: 1,
		});
	}

	setAdminKey(adminKey: string): void {
		this.adminKey = adminKey;
		this.adminKeyChanged();
	}

	clearAdminKey(): void {
		this.adminKey = undefined;
		this.adminKeyChanged();
	}

	protected override postJson<T = unknown>(
		url: string,
		body?: unknown,
		options?: RequestOptions,
	): Promise<T> {
		return super.postJson<T>(url, body, this.withAdminKey(options));
	}

	protected override deleteJson<T = unknown>(
		url: string,
		options?: RequestOptions,
	): Promise<T> {
		return super.deleteJson<T>(url, this.withAdminKey(options));
	}

	private withAdminKey(options?: RequestOptions): RequestOptions {
		const headers = new Headers(options?.headers);
		if (this.adminKey) {
			headers.set("x-api-key", this.adminKey);
		}

		return { ...options, headers: Object.fromEntries(headers.entries()) };
	}

	async getStats(): Promise<StatsWithAccounts> {
		return this.getJson<StatsWithAccounts>("/api/stats");
	}

	getCallerUsage(
		filters: { range: TimeRange; model?: string; caller?: string },
		signal?: AbortSignal,
	): Promise<CallerUsageResponse> {
		const params = new URLSearchParams({ range: filters.range });
		if (filters.model) params.set("model", filters.model);
		if (filters.caller) params.set("caller", filters.caller);
		return this.getJson(
			`/api/usage/callers?${params}`,
			this.withAdminKey({ retries: 0, signal }),
		);
	}

	async getAccounts(): Promise<AccountResponse[]> {
		return this.getJson<AccountResponse[]>("/api/accounts");
	}

	getResetCredits(accountId: string): Promise<ResetCredits> {
		return this.getJson(
			`/api/accounts/${encodeURIComponent(accountId)}/reset-credits`,
			this.withAdminKey({ retries: 0 }),
		);
	}

	consumeResetCredit(
		accountId: string,
		attempt: ResetCreditRequest,
	): Promise<ManualResetResult> {
		// A lost reply must not trigger a new reset. The operator retries the same identity.
		return this.postJson(
			`/api/accounts/${encodeURIComponent(accountId)}/reset-credits/consume`,
			{ ...attempt, confirmed: true },
			{ retries: 0 },
		);
	}

	async createApiKeyAccount(data: {
		name: string;
		provider: ApiKeyProvider;
		apiKey: string;
	}): Promise<{ message: string; accountId: string }> {
		try {
			const result = await this.postJson<MutationResult<AccountCreateData>>(
				"/api/accounts",
				{
					name: data.name,
					provider: data.provider,
					auth_method: "api_key",
					api_key: data.apiKey,
				},
			);
			return {
				message: result.message,
				accountId: result.data?.accountId ?? "",
			};
		} catch (error) {
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async initAddAccount(data: {
		name: string;
		provider: OAuthProvider;
	}): Promise<{ authUrl: string; sessionId: string }> {
		try {
			const result = await this.postJson<MutationResult<AuthInitData>>(
				`/api/auth/${data.provider}/init`,
				data,
			);
			return {
				authUrl: result.data?.authUrl ?? "",
				sessionId: result.data?.sessionId ?? "",
			};
		} catch (error) {
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async completeAddAccount(data: {
		provider: OAuthProvider;
		sessionId: string;
		code: string;
	}): Promise<{ message: string; provider: OAuthProvider }> {
		try {
			const result = await this.postJson<MutationResult<AuthCompleteData>>(
				`/api/auth/${data.provider}/complete`,
				data,
			);
			return {
				message: result.message,
				provider: result.data?.provider ?? data.provider,
			};
		} catch (error) {
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async getAuthSessionStatus(
		sessionId: string,
	): Promise<AuthSessionStatusResponse> {
		try {
			return await this.getJson<AuthSessionStatusResponse>(
				`/api/auth/session/${sessionId}/status`,
			);
		} catch (error) {
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async removeAccount(id: string): Promise<void> {
		try {
			await this.deleteJson(`/api/accounts/${id}`);
		} catch (error) {
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async resetStats(): Promise<void> {
		await this.postJson("/api/stats/reset");
	}

	async getLogHistory(): Promise<LogEvent[]> {
		return this.getJson<LogEvent[]>("/api/logs/history");
	}

	// SSE streaming requires special handling, keep as-is
	streamLogs(onLog: (log: LogEvent) => void): EventSource {
		const eventSource = new EventSource(`/api/logs/stream`);
		eventSource.addEventListener("message", (event) => {
			try {
				const data = parseLogStreamEvent(JSON.parse(event.data));
				if (data && isLogEvent(data)) {
					onLog(data);
				}
			} catch (e) {
				console.error("Error parsing log event:", e);
			}
		});
		return eventSource;
	}

	async getRequestsDetail(
		limit: number = API_LIMITS.requestsDetail,
	): Promise<RequestPayload[]> {
		return this.getJson<RequestPayload[]>(
			`/api/requests/detail?limit=${limit}`,
		);
	}

	async getRequestsSummary(
		limit: number = API_LIMITS.requestsSummary,
	): Promise<RequestSummary[]> {
		return this.getJson<RequestSummary[]>(`/api/requests?limit=${limit}`);
	}

	async getRequestConversation(requestId: string): Promise<RequestPayload[]> {
		return this.getJson<RequestPayload[]>(
			`/api/requests/${encodeURIComponent(requestId)}/conversation`,
		);
	}

	async getAnalytics(
		range: TimeRange = "24h",
		filters?: {
			providers?: AccountProvider[];
			accounts?: string[];
			models?: string[];
			status?: "all" | "success" | "error";
		},
		mode: "normal" | "cumulative" = "normal",
		modelBreakdown?: boolean,
	): Promise<AnalyticsResponse> {
		const params = new URLSearchParams({ range });

		if (filters?.providers?.length) {
			params.append("providers", filters.providers.join(","));
		}
		if (filters?.accounts?.length) {
			params.append("accounts", filters.accounts.join(","));
		}
		if (filters?.models?.length) {
			params.append("models", filters.models.join(","));
		}
		if (filters?.status && filters.status !== "all") {
			params.append("status", filters.status);
		}
		if (mode === "cumulative") {
			params.append("mode", "cumulative");
		}
		if (modelBreakdown) {
			params.append("modelBreakdown", "true");
		}

		return this.getJson<AnalyticsResponse>(`/api/analytics?${params}`);
	}

	async pauseAccount(accountId: string): Promise<void> {
		try {
			await this.postJson(`/api/accounts/${accountId}/pause`);
		} catch (error) {
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async resumeAccount(accountId: string): Promise<void> {
		try {
			await this.postJson(`/api/accounts/${accountId}/resume`);
		} catch (error) {
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async renameAccount(
		accountId: string,
		newName: string,
	): Promise<{ newName: string }> {
		try {
			const result = await this.postJson<MutationResult<{ newName: string }>>(
				`/api/accounts/${accountId}/rename`,
				{ name: newName },
			);
			return { newName: result.data?.newName ?? newName };
		} catch (error) {
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async getStrategy(): Promise<StrategyName> {
		const data = await this.getJson<StrategyResponse>("/api/config/strategy");
		return data.strategy;
	}

	async listStrategies(): Promise<StrategyName[]> {
		return this.getJson<StrategyName[]>("/api/strategies");
	}

	async setStrategy(strategy: StrategyName): Promise<void> {
		try {
			await this.postJson<MutationResult<StrategyResponse>>(
				"/api/config/strategy",
				{ strategy },
			);
		} catch (error) {
			if (error instanceof HttpError) {
				throw new Error(error.message);
			}
			throw error;
		}
	}

	async getRetention(): Promise<RetentionGetResponse> {
		return this.getJson<RetentionGetResponse>("/api/config/retention");
	}

	async setRetention(partial: RetentionSetRequest): Promise<void> {
		await this.postJson("/api/config/retention", partial);
	}

	async cleanupNow(): Promise<CleanupResponse> {
		const result = await this.postJson<MutationResult<CleanupResponse>>(
			"/api/maintenance/cleanup",
		);
		return (
			result.data ?? { removedRequests: 0, removedPayloads: 0, cutoffIso: "" }
		);
	}

	async compactDb(): Promise<void> {
		await this.postJson("/api/maintenance/compact");
	}
}

export const api = new API();
