import type { ProviderCapacityBlock } from "@agent-smith/capacity";
import type { Account, RequestMeta } from "@agent-smith/types";
import type { AccountFact } from "./account-facts";
import type { MessageThreadRequest } from "./handlers/message-thread";
import type { ResolvedPoolContext } from "./pool-context";
import type { TeamRoutingRequest } from "./seat-router";

export type ProxyAttempt =
	| { kind: "authentication-failure" }
	| { kind: "failed" }
	| { kind: "transport-failure" }
	| {
			forward: () => Promise<Response>;
			kind: "per-minute-rate-limit";
			retryAfterMs: number;
	  }
	| { kind: "response"; response: Response }
	| {
			discard?: () => Promise<void>;
			forward: () => Promise<Response>;
			kind: "quota-rate-limit";
	  }
	| {
			block: ProviderCapacityBlock;
			discard?: () => Promise<void>;
			forward: () => Promise<Response>;
			kind: "provider-capacity-block";
	  }
	| { forward: () => Promise<Response>; kind: "request-scoped-rate-limit" }
	| {
			discard?: () => Promise<void>;
			forward: () => Promise<Response>;
			kind: "upstream-failure";
	  };

/** Executes one upstream attempt for a credential selected by the pool. */
export type AttemptExecutor = (
	account: Account,
	failoverAttempts: number,
	report: (fact: AccountFact) => void,
) => Promise<ProxyAttempt>;

export const MAX_INLINE_RATE_LIMIT_RETRY_MS = 60_000;

/** A pool request and the proxy-owned sender bound to this request. */
export type PoolAttemptRequest = {
	body: ArrayBuffer | null;
	ctx: ResolvedPoolContext;
	mappedModel: string | undefined;
	meta: RequestMeta;
	req: Request;
	teamRequest: TeamRoutingRequest;
	thread: MessageThreadRequest | null;
	url: URL;
	execute: AttemptExecutor;
};
