import { nextWindowWarmupAt, type RuntimeConfig } from "@agent-smith/config";
import type { DatabaseOperations } from "@agent-smith/database";
import { Logger } from "@agent-smith/logger";
import type { Provider, ProviderRegistry } from "@agent-smith/providers";
import {
	type Account,
	type AccountQuotaState,
	isOpenQuotaWindow,
} from "@agent-smith/types";
import { isServableSeat } from "./handlers/account-selector";
import type { OutsideSpendTracker } from "./outside-spend";
import {
	type QuotaStore,
	recordSeatQuota,
	type SeatTokenReader,
} from "./quota-probe";

const log = new Logger("WindowWarmup");

type WarmupRuntime = Pick<RuntimeConfig, "quotaThreshold" | "teamRouting">;
type WarmupStore = QuotaStore &
	Pick<DatabaseOperations, "getEnrollmentContact">;

/** A five-hour window runs once it has a reset ahead; one without a reset time has not started. */
function fiveHourWindowRuns(
	provider: Provider,
	account: Account,
	now: number,
): boolean {
	return Object.entries(account.quota_state?.windows ?? {}).some(
		([bucket, window]) =>
			provider.isFiveHourBucket(bucket) &&
			window.resetAt !== null &&
			isOpenQuotaWindow(window, now),
	);
}

/**
 * Opt-in: starts idle pooled seats' five-hour windows at the operator's local
 * times. Only seats the provider would probe directly, so a seat's token never
 * goes to a custom upstream on a request no client sent.
 */
export class WindowWarmup {
	private running = false;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly runtime: () => WarmupRuntime,
		private readonly store: WarmupStore,
		private readonly outsideSpend: OutsideSpendTracker,
		private readonly providers: Pick<ProviderRegistry, "getProvider">,
		private readonly readToken: SeatTokenReader,
		private readonly now: () => number = Date.now,
	) {}

	start(): void {
		this.reschedule();
	}

	reschedule(): void {
		this.scheduleAfter(this.now());
	}

	/** Sends one request per seat that needs it; a failure is logged, never retried. */
	async run(): Promise<void> {
		const runtime = this.runtime();
		const routing = runtime.teamRouting;
		if (this.running || !routing.enabled || !routing.windowWarmup.enabled) {
			return;
		}
		this.running = true;
		try {
			const now = this.now();
			await Promise.all(
				this.store.getAllAccounts().flatMap((account) => {
					const provider = this.providers.getProvider(account.provider);
					return provider && this.needsWarmup(provider, account, runtime, now)
						? [this.warm(provider, account, routing.windowWarmup.model)]
						: [];
				}),
			);
		} finally {
			this.running = false;
		}
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private scheduleAfter(after: number): void {
		this.dispose();
		const dueAt = nextWindowWarmupAt(this.runtime().teamRouting, after);
		if (dueAt === null) return;
		this.timer = setTimeout(
			() => void this.fire(dueAt),
			Math.max(0, dueAt - this.now()),
		);
		this.timer.unref?.();
	}

	private async fire(dueAt: number): Promise<void> {
		await this.run();
		this.scheduleAfter(Math.max(this.now(), dueAt));
	}

	private needsWarmup(
		provider: Provider,
		account: Account,
		runtime: WarmupRuntime,
		now: number,
	): boolean {
		return (
			provider.startQuotaWindow !== undefined &&
			provider.supportsQuotaProbe(account) &&
			!fiveHourWindowRuns(provider, account, now) &&
			isServableSeat(
				provider,
				account,
				runtime.teamRouting.windowWarmup.model ?? undefined,
				{ runtime, dbOps: this.store },
				now,
			)
		);
	}

	private async warm(
		provider: Provider,
		account: Account,
		model: string | null,
	): Promise<void> {
		try {
			const accessToken = await this.readToken(account);
			if (!accessToken) {
				log.warn(`Window warm-up skipped ${account.name}: no access token`);
				return;
			}
			const quota = await this.startWindow(
				provider,
				account,
				accessToken,
				model,
			);
			log.info(`Window warm-up started ${account.name}'s five-hour window`);
			if (quota) {
				recordSeatQuota(
					this.store,
					this.outsideSpend,
					provider,
					account,
					quota,
				);
			}
		} catch (error) {
			log.warn(
				`Window warm-up failed for ${account.name}: ${error instanceof Error ? error.message : "unknown error"}`,
			);
		}
	}

	/** Booked as proxy activity, so the outside-spend view never charges it to the owner. */
	private async startWindow(
		provider: Provider,
		account: Account,
		accessToken: string,
		model: string | null,
	): Promise<AccountQuotaState | null> {
		this.outsideSpend.begin(account.id);
		try {
			return (
				(await provider.startQuotaWindow?.(account, accessToken, model)) ?? null
			);
		} finally {
			this.outsideSpend.end(account.id);
		}
	}
}
