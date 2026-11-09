import type { TeamRoutingConfig } from "@agent-smith/config";

const RAMP_INTERVAL_MS = 250;
const RAMP_WINDOW_MS = 30_000;

export class TeamAdmissionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TeamAdmissionError";
	}
}

export type AdmissionPermit = {
	release: () => void;
};

type QueuedRequest = {
	abort?: () => void;
	config: TeamRoutingConfig;
	deadline: number;
	reject: (reason: Error) => void;
	resolve: (permit: AdmissionPermit) => void;
	signal?: AbortSignal;
};

type AccountAdmission = {
	active: number;
	config: TeamRoutingConfig;
	queue: QueuedRequest[];
	rampTimer: ReturnType<typeof setTimeout> | undefined;
	switchedAt: number | undefined;
};

/**
 * A bounded, per-account FIFO gate. The caller owns response lifetime and must
 * release the returned permit exactly once.
 */
export class TeamAdmission {
	private readonly accounts = new Map<string, AccountAdmission>();

	constructor(private readonly now: () => number = () => Date.now()) {}

	acquire(
		accountId: string,
		config: TeamRoutingConfig,
		signal?: AbortSignal,
	): Promise<AdmissionPermit> {
		if (!config.enabled || config.admissionCap < 1) {
			return Promise.resolve({ release() {} });
		}
		const account = this.account(accountId, config);
		account.config = config;
		this.drain(accountId, account);
		if (account.active < this.capacity(account)) {
			return Promise.resolve(this.grant(accountId, account));
		}
		if (account.queue.length >= config.admissionQueueLimit) {
			return Promise.reject(
				new TeamAdmissionError("Account admission queue is full"),
			);
		}
		if (signal?.aborted) {
			return Promise.reject(
				new TeamAdmissionError(
					"Client disconnected while waiting for account admission",
				),
			);
		}

		return new Promise<AdmissionPermit>((resolve, reject) => {
			const queued: QueuedRequest = {
				config,
				deadline: this.now() + config.admissionWaitMs,
				reject,
				resolve,
			};
			if (signal) {
				queued.signal = signal;
				queued.abort = () => {
					const index = account.queue.indexOf(queued);
					if (index !== -1) account.queue.splice(index, 1);
					reject(
						new TeamAdmissionError(
							"Client disconnected while waiting for account admission",
						),
					);
				};
				signal.addEventListener("abort", queued.abort, { once: true });
			}
			account.queue.push(queued);
			this.scheduleDeadline(accountId, account, queued);
			this.scheduleRamp(accountId, account);
		});
	}

	armSwitch(accountId: string): void {
		const account = this.account(accountId, {
			enabled: true,
			distributionEnabled: true,
			allowlistedAccountUuids: [],
			maxUsage: 0.9,
			admissionCap: 1,
			admissionQueueLimit: 0,
			admissionWaitMs: 0,
			holdSeconds: 0,
			quotaProbeSeconds: 0,
		});
		account.switchedAt = this.now();
		this.scheduleRamp(accountId, account);
	}

	advance(): void {
		for (const [accountId, account] of this.accounts) {
			this.drain(accountId, account);
		}
	}

	private account(
		accountId: string,
		config: TeamRoutingConfig,
	): AccountAdmission {
		const existing = this.accounts.get(accountId);
		if (existing) return existing;
		const created: AccountAdmission = {
			active: 0,
			config,
			queue: [],
			rampTimer: undefined,
			switchedAt: undefined,
		};
		this.accounts.set(accountId, created);
		return created;
	}

	private capacity(account: AccountAdmission): number {
		const base = account.config.admissionCap;
		if (account.switchedAt === undefined) return base;
		const elapsed = this.now() - account.switchedAt;
		if (elapsed >= RAMP_WINDOW_MS) return base;
		return Math.min(
			base,
			1 + Math.floor(Math.max(0, elapsed) / RAMP_INTERVAL_MS),
		);
	}

	private grant(accountId: string, account: AccountAdmission): AdmissionPermit {
		account.active += 1;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				account.active = Math.max(0, account.active - 1);
				this.drain(accountId, account);
			},
		};
	}

	private drain(accountId: string, account: AccountAdmission): void {
		const now = this.now();
		while (account.queue[0] && account.queue[0].deadline <= now) {
			const expired = account.queue.shift() as QueuedRequest;
			this.removeAbort(expired);
			expired.reject(
				new TeamAdmissionError("Timed out waiting for account admission"),
			);
		}
		while (account.queue[0] && account.active < this.capacity(account)) {
			const next = account.queue.shift() as QueuedRequest;
			this.removeAbort(next);
			next.resolve(this.grant(accountId, account));
		}
		if (account.queue.length === 0 && account.rampTimer) {
			clearTimeout(account.rampTimer);
			account.rampTimer = undefined;
		}
	}

	private scheduleDeadline(
		accountId: string,
		account: AccountAdmission,
		queued: QueuedRequest,
	): void {
		if (queued.config.admissionWaitMs <= 0) return;
		setTimeout(
			() => this.drain(accountId, account),
			queued.config.admissionWaitMs,
		);
	}

	private scheduleRamp(accountId: string, account: AccountAdmission): void {
		if (
			account.rampTimer ||
			account.switchedAt === undefined ||
			account.queue.length === 0 ||
			this.now() - account.switchedAt >= RAMP_WINDOW_MS
		) {
			return;
		}
		account.rampTimer = setTimeout(() => {
			account.rampTimer = undefined;
			this.drain(accountId, account);
			this.scheduleRamp(accountId, account);
		}, RAMP_INTERVAL_MS);
	}

	private removeAbort(queued: QueuedRequest): void {
		if (queued.abort && queued.signal) {
			queued.signal.removeEventListener("abort", queued.abort);
		}
		queued.abort = undefined;
		queued.signal = undefined;
	}
}
