import { isAccountAvailable } from "@agent-smith/core";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	StrategyStore,
} from "@agent-smith/types";

export class SessionStrategy implements LoadBalancingStrategy {
	/**
	 * Kept as the configured strategy name until W3 installs per-conversation
	 * affinity. The former five-hour, fleet-wide sticky account is deliberately
	 * gone: its only effect was to overrule the W2 priority and quota ordering.
	 */
	initialize(_store: StrategyStore): void {}

	select(accounts: Account[], _meta: RequestMeta): Account[] {
		return accounts.filter((account) =>
			isAccountAvailable(account, Date.now()),
		);
	}
}
