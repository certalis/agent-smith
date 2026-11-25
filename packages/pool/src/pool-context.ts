import type { ResolvedRuntimeConfig, RuntimeConfig } from "@agent-smith/config";
import type { AsyncDbWriter, DatabaseOperations } from "@agent-smith/database";
import type { Provider, ProviderRegistry } from "@agent-smith/providers";
import type {
	AccountProvider,
	LoadBalancingStrategy,
} from "@agent-smith/types";
import type { MessageThreadBinding } from "./handlers/message-thread";
import type { OutsideSpendTracker } from "./outside-spend";
import type { SeatAlerts } from "./seat-alerts";
import type { TeamRouter } from "./seat-router";
import type { TeamAdmission } from "./team-admission";

/** State and dependencies used by seat selection and credential management. */
export interface PoolContext {
	strategy: LoadBalancingStrategy;
	dbOps: DatabaseOperations;
	runtime: RuntimeConfig;
	providerRegistry: ProviderRegistry;
	refreshInFlight: Map<string, Promise<string>>;
	messageThreads?: Map<string, MessageThreadBinding>;
	quotaProbeAt?: Map<AccountProvider, number>;
	teamRouter?: TeamRouter;
	teamAdmission?: TeamAdmission;
	outsideSpendTracker?: OutsideSpendTracker;
	seatAlerts?: SeatAlerts;
	asyncWriter: AsyncDbWriter;
}

export interface ResolvedPoolContext extends PoolContext {
	runtime: ResolvedRuntimeConfig;
	provider: Provider;
	providerName: AccountProvider;
	upstreamPath: string;
}
