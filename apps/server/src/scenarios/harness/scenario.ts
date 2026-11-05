import type {
	AccountProvider,
	AccountQuotaState,
	AccountSwitchThreshold,
} from "@ccflare/types";

export type Duration = `${number}${"ms" | "s" | "m" | "h"}`;

export type RelativeTime = {
	offsetMs: number;
};

export type FleetAccount = {
	name: string;
	provider?: AccountProvider;
	accountUuid?: string;
	activeSession?: boolean;
	priority?: number;
	switchThreshold?: AccountSwitchThreshold;
	quotaState?: AccountQuotaState;
	authMethod?: "api_key" | "oauth";
	baseUrl?: string;
	rateLimitedFor?: Duration;
	transportFailure?: boolean;
	paused?: boolean;
};

export type RequestStep = {
	type: "request";
	/** Defaults to TCP; Unix requests require the scenario's private socket. */
	transport?: "tcp" | "unix";
	id?: string;
	method?: "GET" | "POST" | "PATCH" | "DELETE";
	path?: string;
	body: string;
	headers?: Record<string, string>;
	count?: number;
	sessionId?: string;
	/** Start requests without waiting so a later step can release an upstream hold. */
	waitForCompletion?: boolean;
	/** Wait until this many total requests have reached the fake upstream. */
	waitForUpstream?: number;
	/** Capture string fields from the first successful response for later {{name}} references. */
	capture?: Record<
		string,
		{ field: string; fragment?: boolean; query?: string }
	>;
};

export type AwaitRequestsStep = {
	type: "await";
	id: string;
};

export type ReleaseHoldStep = {
	type: "release";
	id: string;
};

/** Lets already-started client I/O reach the loopback server without time advancing. */
export type FlushStep = {
	type: "flush";
};

export type WaitForUpstreamStep = {
	type: "wait-for-upstream";
	count: number;
};

export type AdvanceStep = {
	type: "advance";
	by: Duration;
};

/** Evaluates a scenario assertion at this point in the injected clock. */
export type AssertStep = {
	assertions: ScenarioAssertion[];
	type: "assert";
};

export type ScenarioStep =
	| { type: "restart" }
	| { type: "block-config-write" }
	| { type: "restore-config-write" }
	| RequestStep
	| AdvanceStep
	| AssertStep
	| AwaitRequestsStep
	| ReleaseHoldStep
	| FlushStep
	| WaitForUpstreamStep;

export type SseChunk = {
	body: string;
	afterClientChunk?: boolean;
};

export type UpstreamRule = {
	id?: string;
	account?: string;
	path?: string;
	times?: number;
	status: number;
	headers?: Record<string, string | RelativeTime>;
	json?: unknown;
	sse?: SseChunk[];
	hold?: {
		received: number;
		within?: Duration;
		release?: "automatic" | "manual";
	};
};

export type UpstreamAssertion = {
	id: string;
	type: "upstream";
	/** Grade only the requests recorded at this path, such as one alert channel. */
	onPath?: string;
	count?: number;
	atMostPerHeader?: { name: string; count: number };
	eachHeaderIncludesAccount?: { name: string; account: string; count?: number };
	atLeastAccount?: { name: string; count: number };
	accounts?: string[];
	/** No recorded request may arrive while this named manual hold is active. */
	neverWhileHold?: string;
	path?: string;
	header?: { name: string; value: string };
	headerAbsent?: string;
	bodyIdentical?: string | string[];
	bodyIncludes?: string[];
};

export type ClientAssertion = {
	id: string;
	type: "client";
	index?: number;
	request?: string;
	status?: number;
	statuses?: number[];
	unorderedStatuses?: number[];
	body?: string;
	bodyIncludes?: string;
	bodyExcludes?: string[];
	jsonPath?: { path: string; value: unknown };
	chunks?: string[];
	header?: { name: string; value: string };
	headerAbsent?: string;
};

export type AccountAssertion = {
	id: string;
	type: "account";
	current?: string;
	limited?: string;
	limitedUntil?: string | RelativeTime;
	notLimited?: string;
	quotaWindow?: {
		account: string;
		bucket: string;
		utilization: number | null;
	};
	quotaWindowAbsent?: { account: string; bucket: string };
};

export type ScenarioAssertion =
	| UpstreamAssertion
	| ClientAssertion
	| AccountAssertion;

export type ExpectedRed = {
	reason: string;
	assertions: string[];
};

export type Scenario = {
	name: string;
	/** Start an extra Unix listener inside this scenario's temporary workspace. */
	privateSocket?: boolean;
	config?: Record<string, unknown>;
	environment?: Record<string, string>;
	/** Remap only Claude OAuth token/profile fetches to this scenario's fake HTTP upstream. */
	claudeOAuth?: boolean;
	fleet: FleetAccount[];
	steps: ScenarioStep[];
	upstream: UpstreamRule[];
	assertions: ScenarioAssertion[];
	expectedRed?: ExpectedRed;
	upstreamTest?: string;
};

const DURATION_MULTIPLIERS = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
} as const;

export function durationMs(duration: Duration): number {
	const match = /^(\d+)(ms|s|m|h)$/.exec(duration);
	if (!match) {
		throw new Error(`Invalid scenario duration: ${duration}`);
	}

	const [, amount, unit] = match;
	return (
		Number(amount) *
		DURATION_MULTIPLIERS[unit as keyof typeof DURATION_MULTIPLIERS]
	);
}

export function at(offset: Duration): RelativeTime {
	return { offsetMs: durationMs(offset) };
}

export function defineScenario(scenario: Scenario): Scenario {
	return scenario;
}
