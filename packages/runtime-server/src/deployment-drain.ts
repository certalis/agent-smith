import { Logger } from "@agent-smith/logger";

/** A renewable operator pause, never a persisted account/configuration change. */
export class DeploymentDrain {
	private expiresAt: number | null = null;
	private stopping = false;
	private readonly log = new Logger("DeploymentDrain");

	constructor(
		private readonly activity: () => {
			activeRequests: number;
			activeWebSockets: number;
		},
		private readonly now: () => number = () => Date.now(),
	) {}

	isDraining = (): boolean => {
		if (this.expiresAt !== null && this.now() >= this.expiresAt) {
			this.expiresAt = null;
			this.log.info("Deployment pause expired; accepting new inference");
		}
		return this.stopping || this.expiresAt !== null;
	};

	control = (action: "start" | "status" | "resume") => {
		if (action === "start" && !this.stopping) {
			if (!this.isDraining()) this.log.info("Deployment pause started");
			this.expiresAt = this.now() + 120_000;
		} else if (action === "resume" && !this.stopping) {
			this.expiresAt = null;
			this.log.info("Deployment pause cancelled; accepting new inference");
		}
		return {
			draining: this.isDraining(),
			expiresAt: this.expiresAt,
			...this.activity(),
		};
	};

	shutdown(): void {
		this.stopping = true;
		this.expiresAt = null;
	}
}
