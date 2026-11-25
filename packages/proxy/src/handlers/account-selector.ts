import type { PoolContext } from "@agent-smith/pool";
import { getCallerPoolStatus as getStatus } from "@agent-smith/pool";
import type { ProviderWire } from "@agent-smith/types";
import { hasOrderedProviderFallback } from "../team-router";

export * from "@agent-smith/pool";

export function getCallerPoolStatus(
	wire: ProviderWire,
	model: string | undefined,
	callerId: string,
	ctx: Pick<PoolContext, "runtime" | "dbOps" | "providerRegistry">,
) {
	return getStatus(
		wire,
		model,
		callerId,
		ctx,
		hasOrderedProviderFallback(ctx.runtime.teamRouting, callerId),
	);
}
