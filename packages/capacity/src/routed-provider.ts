import type { ProviderWire, RequestMeta } from "@agent-smith/types";
import type { ProviderCapacityBlock } from "./index";

export type RouteScope =
	| { kind: "pool-route"; wire: ProviderWire }
	| { kind: "direct"; provider: string };

/** The edge's read-only view; provider-choice headers are removed before forwarding. */
export type EdgeRequest = Readonly<{
	method: string;
	url: URL;
	headers: Headers;
	body: ArrayBuffer | null;
	meta: RequestMeta;
}>;

export type RouteRequest = {
	scope: RouteScope;
	edge: EdgeRequest;
	model?: string;
	callerId?: string;
	sessionId: string | null;
	openingDigest: string | null;
	/** Opaque identity shared by provider candidates for this request. */
	seatPinLookup?: object;
	seatHint?: string;
	apiKeyAccounts: boolean;
	inlineRateLimitRetry: boolean;
	signal: AbortSignal;
	beforeAttempt?: () => void;
};

export type Availability = {
	capacity:
		| { state: "available" }
		| {
				state: "blocked";
				block: ProviderCapacityBlock;
				fleetFull: boolean;
				fleetResetAt: number | null;
		  }
		| { state: "unknown" };
	holdsConversation: boolean;
	threadRequest: boolean;
};

export type ProviderStatus = {
	servableSeats: number;
	retryAt: number | null;
	admissionWaitMs: number;
};

export type ServeOutcome =
	| { kind: "final"; response: Response; providerServed: boolean }
	| {
			kind: "exhausted";
			reason:
				| "capacity-block"
				| "quota"
				| "upstream-failure"
				| "transport"
				| "all-failed"
				| "no-eligible-account";
			block?: ProviderCapacityBlock;
			forward?: () => Promise<Response>;
			discard?: () => Promise<void>;
	  };

/** Opaque websocket attempts are created by the edge executor, without exposing accounts to routing. */
export type SessionOutcome =
	| {
			kind: "prepared";
			session: {
				close(): void;
				next(): Promise<{ handle: object; attemptNumber: number } | null>;
			};
	  }
	| { kind: "unavailable"; reason: string };

export interface RoutedProvider {
	readonly name: string;
	readonly wire: ProviderWire;
	mapModel(model: string | undefined): string | undefined | null;
	availability(request: RouteRequest): Promise<Availability>;
	status(request: RouteRequest): Promise<ProviderStatus>;
	serve(request: RouteRequest): Promise<ServeOutcome>;
	openSession?(request: RouteRequest): Promise<SessionOutcome>;
}
