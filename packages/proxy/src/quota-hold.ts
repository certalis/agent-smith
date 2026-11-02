type Waiter = {
	reject: (reason: Error) => void;
	resolve: () => void;
	resetAt: number;
	signal?: AbortSignal;
	onAbort?: () => void;
};

/** Wakes exhausted requests from the injected clock or a production timer. */
export class QuotaHold {
	private readonly waiters = new Set<Waiter>();

	constructor(private readonly now: () => number = () => Date.now()) {}

	waitUntil(resetAt: number, signal?: AbortSignal): Promise<void> {
		if (resetAt <= this.now()) return Promise.resolve();
		if (signal?.aborted) {
			return Promise.reject(
				new Error("Client disconnected while waiting for quota"),
			);
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { reject, resetAt, resolve, signal };
			if (signal) {
				waiter.onAbort = () => {
					this.waiters.delete(waiter);
					reject(new Error("Client disconnected while waiting for quota"));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.waiters.add(waiter);
			setTimeout(() => this.advance(), Math.max(0, resetAt - this.now()));
		});
	}

	advance(): void {
		for (const waiter of this.waiters) {
			if (waiter.resetAt > this.now()) continue;
			this.finish(waiter);
			waiter.resolve();
		}
	}

	dispose(): void {
		for (const waiter of this.waiters) {
			this.finish(waiter);
			waiter.reject(new Error("Quota hold stopped"));
		}
	}

	private finish(waiter: Waiter): void {
		this.waiters.delete(waiter);
		if (waiter.signal && waiter.onAbort) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
		}
	}
}
