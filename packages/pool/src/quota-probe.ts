import type { ProviderPoolSettings } from "@agent-smith/config";
import type { Provider, ProviderRegistry } from "@agent-smith/providers";
import type { Account, AccountQuotaState } from "@agent-smith/types";
import type { OutsideSpendTracker } from "./outside-spend";

export type QuotaStore = {
	getAllAccounts(): Account[];
	updateAccountQuotaState(
		accountId: string,
		quotaState: AccountQuotaState,
	): void;
};

export type SeatTokenReader = (account: Account) => Promise<string | null>;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Saves a reading taken outside proxy traffic, after outside spend has judged it. */
export function recordSeatQuota(
	store: QuotaStore,
	outsideSpend: OutsideSpendTracker,
	provider: Provider,
	account: Account,
	quota: AccountQuotaState,
): void {
	const observed = outsideSpend.observe(account, quota, provider);
	account.quota_state = observed;
	store.updateAccountQuotaState(account.id, observed);
}

/** Opt-in zero-spend quota refresh for direct subscription seats. */
export class QuotaProbe {
	private intervalMs = 0;
	private running = false;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly config: () => ProviderPoolSettings,
		private readonly store: QuotaStore,
		private readonly outsideSpend: OutsideSpendTracker,
		private readonly providers: Pick<ProviderRegistry, "getProvider">,
		private readonly readToken: SeatTokenReader = async (account) =>
			account.access_token,
	) {}

	start(): void {
		this.reschedule();
	}

	reschedule(): void {
		const routing = this.config();
		const desired = routing.enabled
			? Math.min(MAX_INTERVAL_MS, routing.quotaProbeSeconds * 1_000)
			: 0;
		if (desired === this.intervalMs) return;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.intervalMs = desired;
		if (desired === 0) return;
		void this.run();
		this.timer = setInterval(() => void this.run(), desired);
		this.timer.unref?.();
	}

	async run(): Promise<void> {
		if (this.running || this.intervalMs === 0) return;
		this.running = true;
		try {
			const routing = this.config();
			await Promise.all(
				this.store
					.getAllAccounts()
					.filter((account) => this.probeable(account, routing))
					.map((account) => this.probeAccount(account)),
			);
		} finally {
			this.running = false;
		}
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.intervalMs = 0;
	}

	private probeable(account: Account, config: ProviderPoolSettings): boolean {
		const provider = this.providers.getProvider(account.provider);
		return (
			provider?.supportsQuotaProbe(account) === true &&
			!!account.account_uuid &&
			config.allowlistedAccountUuids.includes(account.account_uuid)
		);
	}

	private async probeAccount(account: Account): Promise<void> {
		try {
			const provider = this.providers.getProvider(account.provider);
			if (!provider) return;
			const accessToken = await this.readToken(account);
			if (!accessToken) return;
			const quota = await provider.probeQuota(account, accessToken);
			if (!quota) return;
			recordSeatQuota(this.store, this.outsideSpend, provider, account, quota);
		} catch {
			// A failed read is not evidence: retain the last trusted quota reading.
		}
	}
}
