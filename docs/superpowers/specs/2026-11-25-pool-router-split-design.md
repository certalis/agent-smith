# Pool and Router split

## Intent

Agent Smith pools subscription accounts and routes requests between providers
and models. Both jobs are still connected inside the proxy, and the fallback
settings are spread across provider definitions, provider pools and team
routing. Make the **Pool** and the **Router** clearly separate modules inside
the same npm package, process and deployment:

- the Pool manages accounts and reports capacity;
- the Router decides which provider and model to use, including whether to
  wait or fall back.

The Router must later be able to use personal accounts and several team pools.
A separate service is not required.

## Decisions already taken

- **The Router sees providers only.** The owner, 2026-11-25: « when the router
  picks a provider, it should not need to know that that provider is pooled ».
  A route lists provider names. Whether a provider is served by one key or by
  a pool of seats is that provider's configuration, behind one interface.
- **Every seat ceiling stays with the pool.** Owner ceilings (`max_usage`,
  `weekly_max_usage`, `weekly_max_usage_by_email`) and caller ceilings
  (`caller_weekly_max_usage`) are per-seat eligibility rules; the pool applies
  the stricter one. The Router's caller policy is which providers a caller may
  reach and whether it may move on.
- **Hard configuration switch.** Four users: the release reads only the new
  shape and refuses the old keys at startup. Tokens live in the `accounts`
  table keyed by provider name, so keeping the names `claude-code` and `codex`
  keeps every seat signed in.
- **No behavior change** for clients: same responses, waits, fallbacks,
  chooser prompts, seat pins and provider preferences.

## What is tied together today

| # | Coupling | Where |
|---|---|---|
| 1 | The account loop decides whether to try the next provider | `proxy/src/pool/provider-pool-attempts.ts` `proxyPoolCandidate(…, allowNextProvider)` |
| 2 | Provider choice reads the seat pin and account rows | `proxy/src/provider-pool.ts` (`getPinnedAccountId` → `dbOps.getAccount`) |
| 3 | The chooser learns capacity by preparing a full request per provider | `proxy/src/pool/interactive-provider-pool.ts` `eligiblePoolProviders` |
| 4 | Account eligibility reads caller routing policy | `admittedPoolAccounts`; `handlers/account-selector.ts` `getCallerPoolStatus`, `callerPoolAccounts` |
| 5 | Router behavior is gated by the pool switch | `team-router.ts` `hasOrderedProviderFallback` requires `team_routing.enabled`; `proxy.ts` `handleProxy` waits only when it is on |
| 6 | Two wait implementations | `proxy.ts` `handleProxy`, `interactive-provider-pool.ts` `waitOrReturnProviderCapacity` |
| 7 | The executor reads the chooser header | `handlers/proxy-operations.ts` `classifyUpstreamResponse` (`interactiveProviderChoiceRequested`) |
| 8 | Forwarding code writes account rows | `response-processor.ts:120,145,163`, `proxy-operations.ts:155,225`, `token-manager.ts:54,135` |
| 9 | The websocket path selects and fails over on its own | `websocket-proxy.ts:688` |
| 10 | One context object carries every module's state | `handlers/proxy-types.ts` `ProxyContext` |

## Modules

| Module | Package | Owns | May import |
|---|---|---|---|
| Router | `@agent-smith/routing` | Routes (wire → ordered provider names), caller reach and fallback, wait, chooser and promotion, conversation provider preference and blocks, the answer when every allowed provider is blocked | `capacity`, `types` |
| Provider interface | `@agent-smith/capacity` | The interface below and the block vocabulary | `types` |
| Pool | `@agent-smith/pool` (new) | Account supply for every provider: account choice, credentials and refresh, cooldowns, quota readings, seat pins, thread binding, admission, ceilings, probe, warm-up, alerts, same-provider retries | `capacity`, `providers`, `database`, `config`, `types` |
| Connector | `@agent-smith/providers` | Native auth, URLs, model maps, limit and usage parsing | as today |
| Proxy | `@agent-smith/proxy` | HTTP and websocket edge, executor (send one attempt with one credential, classify, stream, usage worker), wiring Router to providers | all of the above |

Every provider gets its accounts through the Pool module. A provider without a
`pool` block uses today's plain selection (priority, cooldown, quota threshold,
one-sibling retry). A `pool` block turns on team rules: members, ceilings,
seat pins and distribution, admission, probe, warm-up, alerts.

Dependency rule, enforced in `apps/server/src/package-boundaries.integration.test.ts`:
`routing` imports neither `pool`, `database` nor `providers`; `pool` does not
import `routing`; no account object, token or account id crosses into
`routing`.

## Provider interface

```ts
// @agent-smith/capacity
type RouteScope = { kind: "pool-route"; wire: ProviderWire } | { kind: "direct"; provider: string };

type EdgeRequest = {          // read-only view of the client request
	method: string;
	url: URL;
	headers: Headers;            // provider-choice headers already stripped
	body: ArrayBuffer | null;    // the opening digest and message-thread parse read it
	meta: RequestMeta;
};

type RouteRequest = {
	scope: RouteScope;           // keeps today's pin keys byte-identical
	edge: EdgeRequest;
	model?: string;              // requested model; each provider maps it itself
	callerId?: string;           // registered device, server-side only
	sessionId: string | null;
	openingDigest: string | null; // computed once by the edge with the route's first provider's parser; opaque
	seatHint?: string;           // manual pin `/tc-acct/<name>/…`: opaque, the Router only passes it on
	apiKeyAccounts: boolean;     // Router's reach decision; the Pool applies it to account auth
	inlineRateLimitRetry: boolean; // today: chooser-capable requests only
	signal: AbortSignal;
};

type Availability = {
	capacity:
		| { state: "available" }
		| { state: "blocked"; block: ProviderCapacityBlock; fleetFull: boolean; fleetResetAt: number | null }
		| { state: "unknown" };   // no reading: try it
	holdsConversation: boolean; // a seat pin for this conversation lives on this provider
	threadRequest: boolean;     // any message-thread request: never offered in the chooser
};

type ProviderStatus = {        // `/api/pool-status`: counts, never identities
	servableSeats: number;
	retryAt: number | null;
	admissionWaitMs: number;
};

type ServeOutcome =
	| {
			kind: "final";                          // client gets this; routing stops
			response: Response;
			providerServed: boolean;                // an account answered first-hand (today's `result.account`)
	  }
	| {
			kind: "exhausted";                      // every allowed account tried or none eligible
			reason: "capacity-block" | "quota" | "upstream-failure" | "transport" | "all-failed" | "no-eligible-account";
			block?: ProviderCapacityBlock;
			forward?: () => Promise<Response>;      // the upstream's own answer, when today forwards it
			discard?: () => Promise<void>;
	  };

interface RoutedProvider {
	readonly name: string;
	readonly wire: ProviderWire;
	mapModel(model: string | undefined): string | undefined | null; // null: not served
	availability(request: RouteRequest): Promise<Availability>;     // advisory snapshot
	status(request: RouteRequest): Promise<ProviderStatus>;
	serve(request: RouteRequest): Promise<ServeOutcome>;
	openSession?(request: RouteRequest): Promise<SessionOutcome>;  // websocket
}
```

Names and fields are a starting point for task 2 of the plan; the outcome
mapping below is the contract. The manual chooser
(`createManualProviderChoiceResponse`), promotion details and served-provider
headers stay Router outputs, built from `availability()`.

### Outcome mapping (today's behavior)

A pool route tries more than one provider only for a chooser pick (exactly
that provider) or an ordered caller (from the current provider onward):
`routing/src/provider-selection.ts` `selectPoolProviders`. Every other request
gets one provider, so « next provider » below applies to ordered callers.

The Pool keeps today's two account loops, chosen by `scope`: on a pool route a
capacity block discards and tries the provider's next account
(`pool/provider-pool-attempts.ts` `proxyPoolCandidate`); on a direct route it
is forwarded from the first account (`handlers/proxy-attempts.ts`
`proxySelectedAccounts`). Quota, upstream and transport failures on a
non-last account get today's one-sibling resolution and return `final`.

| Today's result on the provider's last account | Pool returns | Router does (pool route) | Router does (direct route) |
|---|---|---|---|
| response, or any result a sibling resolved | `final` | return it | return it |
| `authentication-failure` | `final` (502) | return it | return it |
| `per-minute-rate-limit`: over 60 s forwarded at once; else wait and retry the same account once | `final` | return it, never move | return it |
| `request-scoped-rate-limit`: no sibling → forwarded; else one sibling, and a delayed retry only when the sibling is request-scoped too | `final` | return it | return it |
| `provider-capacity-block` | `exhausted` `capacity-block` + block | record the block; ordered caller: next provider; else the capacity problem (every caller) | `forward()` |
| `quota-rate-limit` | `exhausted` `quota` | ordered caller: discard, next; else `forward()` | `forward()` |
| `upstream-failure` | `exhausted` `upstream-failure` | ordered caller: discard, next; else `forward()` | `forward()` |
| `transport-failure` | `exhausted` `transport` | ordered caller: next; else 502 | 502 |
| `failed` on every account (auth cooldown, quarantine, refresh error) | `exhausted` `all-failed` | ordered caller: next; else 502 | 503 « all accounts failed » |
| no eligible account before sending | `exhausted` `no-eligible-account` + block | next candidate; when none: interactive → capacity problem with choices; else 429 with the soonest retry, or 503 | hold within `hold_seconds` when the provider is pooled, then 429 with the soonest retry, or 503 |

Waits stay where they are today, in one Router implementation: a direct route
on a pooled provider holds within `hold_seconds` (`proxy.ts` `handleProxy`);
an interactive « Wait » choice waits for the conversation block's `retryAt`
within `hold_seconds`, retries once, else answers the capacity problem again
(`pool/interactive-provider-pool.ts` `waitOrReturnProviderCapacity`). A
non-interactive pool route never holds.

The Router records a conversation block on `exhausted` with a block. It
clears the block and stores a chooser pick only on a `final` with
`providerServed` (today: `provider-pool-attempts.ts:229`, only when the
result carries an account); forwarded errors and sibling-resolved answers
change neither. The Pool rebinds its seat pin itself when a moved provider or
sibling serves. The provider holding the conversation's seat pin comes first,
as today (`provider-pool.ts:119`), read from `holdsConversation`. When every
candidate of a route is full,
the Router reports it through a callback the proxy wires to the Pool's seat
alerts, with today's label `provider_pools.<wire>` (`provider-pool.ts`
`allAccountsFull`).

### Rules the interface keeps

- **Availability is advisory.** A provider listed as available may return
  `exhausted` on serve. Router treats it like any block: no second send to the
  same provider, no leaked stream, no leaked admission permit.
- **Retries stop once the response starts.** `final` is committed; the Pool's
  same-provider retries and the Router's next provider happen only before the
  first byte reaches the client.
- **Permits.** HTTP releases its admission permit when the response stream
  ends, errors or is cancelled, and on every non-`final` attempt. The
  websocket path takes no admission permit and no in-flight count today
  (`websocket-proxy.ts:688`); the split keeps it that way.
- **Manual pin.** `seatHint` carries the `/tc-acct/<name>/` account name from
  the edge to the Pool. The Router never reads it; it is the one
  account-shaped value that crosses, as an opaque string.
- **Keys.** Seat pin keys keep `team-router.ts` `pinKey`'s inputs (scope,
  model bucket, session id, opening digest) and today's two parsers: the
  lookup uses `openingDigest`, parsed once with the route's first provider's
  `getConversationOpening` (`provider-pool.ts:113`), even when the pinned seat
  belongs to another provider; the rebind after a serve parses with the
  serving provider's (`team-router.ts:257`). The Router derives the provider
  conversation key from scope and session id, as `providerConversationKey`
  does. Golden tests pin all three from raw request bodies.
- **API-key reach** applies on every serve, direct and pool routes alike, for
  every provider with or without a `pool` block: today, with team routing on,
  direct selection excludes keys even on a keys-only provider
  (`team-router.ts` `isAllowlisted` admits OAuth seats only).
- **Account state is written by the Pool only.** The executor returns what it
  parsed (quota windows, rate-limit reset, refreshed tokens, auth failure) in
  its attempt result; the Pool persists it with today's timing (at upstream
  headers; seat pins at selection, before the upstream call). The
  post-processor worker's `updateAccountUsage` (request count, last used, at
  worker start) stays in the worker, which has its own database handle; it is
  a usage counter, not an eligibility input. Control-plane writes (account
  API, enrollment, OAuth flow) are unchanged.

## Configuration

Hard switch: `team_routing` and `provider_pools` are refused at startup with a
message naming the new fields. The standalone pool redeploys on every merge to
`main` and its disk forbids a second instance, so the switch is staged (plan,
task 12): the rewritten config sits beside the live one, PR 5 merges with
auto-deploy paused, and the deploy points `AGENT_SMITH_CONFIG_PATH`
(`packages/config/src/paths.ts`) at the new file. Rollback points it back and
redeploys the previous commit; the old file is never edited.

```json
{
  "providers": {
    "claude-code": {
      "enabled": true,
      "pool": {
        "members": ["<account uuid>"],
        "max_usage": 0.9,
        "weekly_max_usage": 0.95,
        "weekly_max_usage_by_email": {},
        "caller_weekly_max_usage": {},
        "admission": { "cap": 5, "queue_limit": 25, "wait_ms": 30000 },
        "distribution_enabled": true,
        "prefer_expiring_quota": false,
        "quota_probe_seconds": 0,
        "window_warmup": { "enabled": false },
        "block_when_all_full": true
      }
    },
    "kimi-code": { "enabled": true, "strategy": "kimi-code-anthropic-api", "models": { "*": "k3.1-pro" } }
  },
  "routing": {
    "routes": { "anthropic-messages": ["claude-code", "kimi-code"] },
    "api_key_accounts": "chooser_or_fallback",
    "callers": { "<device>": { "allow_fallbacks": true } },
    "hold_seconds": 0
  }
}
```

| Today | New place |
|---|---|
| `team_routing.enabled` + `allowlisted_account_uuids` | a `pool` block on every provider with subscription accounts, `members` = its allowlisted seats (possibly none) |
| `team_routing` seat fields, `block_when_all_full` | that provider's `pool` block |
| `caller_weekly_max_usage` | each `pool` block (per-seat rule) |
| `provider_pools` | `routing.routes`, same shape |
| `caller_provider_fallback: { "<device>": "ordered" }` | `routing.callers.<device>.allow_fallbacks: true` (OpenRouter's name; today's enum has one value) |
| `hold_seconds` | `routing.hold_seconds`; the direct-route hold applies to providers with a `pool` block |
| API-key accounts (team routing on): pool routes only, for a chooser-capable request (the companion's capability header, not a pick) or an ordered caller; never direct routes (`interactive-provider-pool.ts:50`, `team-router.ts` `eligibleAccounts`) | `routing.api_key_accounts: "chooser_or_fallback"`; default `"everyone"` (team routing off). The Router turns it into `RouteRequest.apiKeyAccounts`; the Pool applies it by account auth method, so a provider mixing seats and keys behaves as today |
| `quota_threshold`, `alerts`, `enrollment_emails`, `client` | unchanged |

One intentional change: `allow_fallbacks` works without any `pool` block
(today it needs `team_routing.enabled`), so a router-only setup, such as
personal accounts later, can fall back. No existing configuration changes
behavior: the rewrite carries callers over only from configurations with team
routing on. Tested in task 10.

Private maps (`weekly_max_usage_by_email`, `caller_weekly_max_usage`,
`routing.callers`) stay write-only through the API, as today.

## Prior art

| Project | Shape | Fails our cases on |
|---|---|---|
| [LiteLLM Router](https://docs.litellm.ai/docs/routing) | Deployments sharing a `model_name` form a group it balances and cools down; `fallbacks` maps a group to other groups after `num_retries`; `order` tiers inside a group; per-key `disable_fallbacks`; `session_affinity` pins a session to a deployment (memory or Redis, idle TTL) | Python service; ceilings it counts itself (`max_budget`, `rpm`/`tpm`), never upstream windows; no subscription seat pooling ([discussion 32328](https://github.com/BerriAI/litellm/discussions/32328)); no chooser |
| [Portkey Gateway](https://portkey.ai/docs/product/ai-gateway/load-balancing) | `strategy.mode: single | loadbalance | fallback | conditional` over nested `targets`; `on_status_codes` decides which statuses move on | Node/workerd server with no library export; targets are API keys; sticky balancing is Enterprise only |
| [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) | `provider.order`, `allow_fallbacks`, `only`/`ignore`; keeps a conversation on a provider while its prompt cache is warm | Hosted service; API billing, no seats |
| [TensorZero](https://github.com/tensorzero/tensorzero) | Ordered `routing = [...]` over providers | Rust service; no seats, windows, pins or chooser |
| [Kong AI Proxy Advanced](https://developer.konghq.com/plugins/ai-proxy-advanced/), Envoy AI Gateway, Helicone AI Gateway | Priority or hashed balancing, failover on listed statuses | Separate gateways; usage counted from tokens or cost; no chooser |
| [TeamClaude](https://github.com/KarpelesLab/teamclaude) | Rotates Claude subscriptions on 5h/7d buckets, priority fallback to API providers, `holdSeconds` | Standalone server, no library API; one proxy key, so no per-caller limits; no admission cap; switching from a TUI, not a per-request capacity answer |
| [underclass](https://github.com/ghuntley/underclass) | Flat pool of Claude subscriptions, SQLite pins for 24 h | Standalone Rust server; no ordered fallback, chooser, caller limits or websocket; Claude Code only |

Conclusion: build. No candidate runs inside the Bun process and also reads
subscription windows from upstream headers, applies per-seat owner and caller
ceilings and answers with a structured chooser problem. Keep the shape they
share: a route is an ordered list of provider names (TensorZero `routing`,
OpenRouter `order`), each entry may hide a balanced group (Portkey nested
`targets`, LiteLLM groups), and per-caller fallback is a boolean (OpenRouter
`allow_fallbacks`, LiteLLM `disable_fallbacks`). `api_key_accounts` has no
standard equivalent. A fresh `buy-critic` checked this table on 2026-11-25
(« build stands »).

## Non-goals

- A separate process or service, remote or layered pools.
- New providers, adapters or protocol translation changes.
- New fallback policies (for example automatic moves between two pooled
  providers of the same model).
- Per-person usage tracking.
- Validating a forwarded claude.ai login (`keep_claude_login`) as a personal
  provider: separate, under each provider's terms.

## Proof

- No scenario assertion changes; fixture and wiring edits are named in the PR.
- Golden tests for seat pin keys (both scopes) and provider conversation keys.
- New scenarios: seat pin and provider preference across a restart, and a
  seat pin with no provider preference across a restart; a provider
  listed by the chooser that blocks on serve; a manual pin on a pool route;
  API-key account reach for each combination of chooser-capable, ordered,
  ordinary caller, team routing on and off, pool and direct route;
  admission permit and queue recovered after a cancellation before headers
  and mid-stream; websocket failed initial connect → next account and no
  failover once connected; a route whose two providers the Router cannot tell
  apart (one pooled, one API key); two pooled providers of the same model in
  one route.
- Routing unit tests run against fake `RoutedProvider`s only.
- Each PR lists the real-client checks it ran (Claude Code and Codex wrappers
  against the fake upstream) and any it could not run.
