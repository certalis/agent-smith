# Pool and Router split implementation plan

> **Execution:** not started. Each PR below waits for the owner's go; every
> merge to `main` redeploys and restarts the standalone pool, so merges land in
> quiet hours. PR 5 is the exception: it merges with auto-deploy paused, during
> the staged switch of task 12.

**Goal:** Separate the Pool (accounts and capacity) from the Router (provider
and model choice, wait, fallback) inside the same package and process, with no
behavior change for clients, then move each setting next to its owner with a
hard configuration switch. Spec:
[`../specs/2026-11-25-pool-router-split-design.md`](../specs/2026-11-25-pool-router-split-design.md).

**Architecture:** The provider interface lives in `@agent-smith/capacity`. A
new `@agent-smith/pool` package owns every account and seat rule and serves a
provider behind that interface, pooled or not. `@agent-smith/routing` gains a
`Router` that walks a route of provider names, waits, falls back and answers
the chooser, against the interface only. `@agent-smith/proxy` keeps the edge
and the one-attempt executor and wires the two.

**Tech stack:** Bun/TypeScript workspaces, SQLite repositories, the scenario
harness in `apps/server/src/scenarios/`, the package-boundary test.

**Estimate:** 11–14.5 agent days with same-day review, about 3 calendar weeks.
Tasks 1–9 (the split on today's configuration) ship alone in 8–10.5 days.
Provisional: re-estimated after task 1 and again after task 3, the two places
the seams can turn out wider than mapped.

---

## PRs

| PR | Tasks | Effort | Behavior change |
|---|---|---|---|
| 1 Characterization | 1 | 1 d | none (tests only) |
| 2 Pool | 2–5 | 3–4 d | none |
| 3 Router | 6–8 | 3–4 d | none |
| 4 Second-provider proof | 9 | 1 d | none |
| 5 Configuration switch | 10–11 | 1.5–2.5 d | config shape; `allow_fallbacks` without a pool (intentional, tested) |
| webapp PR + staged switch | 12 | 1 d | operator scripts follow the new shape |
| 6 Docs and release | 13 | 0.5 d | none |

Feature PRs on `packages/proxy` during PRs 2–3 cost 1–2 days of rebase each;
pausing them for those two weeks is cheaper.

---

### Task 1: Characterize what the split must not change (PR 1)

**Files:**
- Create: `packages/proxy/src/routing-keys.golden.test.ts`
- Create: `apps/server/src/scenarios/pin-and-preference-restart.scenario.ts`
- Create: `apps/server/src/scenarios/chooser-listed-then-blocked.scenario.ts`
- Create: `apps/server/src/scenarios/manual-pin-pool-route.scenario.ts`
- Create: `apps/server/src/scenarios/api-key-account-reach.scenario.ts`
- Create: `apps/server/src/scenarios/cancellation-releases-admission.scenario.ts`
- Modify: `apps/server/src/websocket.integration.test.ts` (new cases only)

1. Golden test from raw request bodies (both scopes `pool:<wire>` and a
   provider name, a model with and without a quota bucket, a session id, an
   opening each provider parses): today's `team-router.ts` `pinKey` and
   `providerConversationKey` strings, byte for byte. The expected strings are
   literals, not recomputed. One case uses two providers whose
   `getConversationOpening` differ, with a pin persisted on the second: the
   lookup parses with the first provider, the rebind with the serving one.
2. Restart scenarios with the existing `restart` step: a conversation with a
   seat pin and a chosen provider, and one with a seat pin on the second
   provider but no provider preference; the next turn reaches the same seat
   and provider.
3. Scenario: the chooser lists a provider, the client picks it, its upstream
   answers with a capacity block. Assert today's answer, one upstream send to
   that provider, and that the admission count returns to zero. If today's
   answer looks wrong, record it in the PR and leave it: this PR changes no
   behavior.
4. Scenario: a `/tc-acct/<name>/v1/pool/<wire>/…` request, with the named
   seat in the first provider and in the second; assert today's answer.
5. Scenario table for API-key account reach: chooser-capable header without a
   pick, chooser pick, ordered caller, ordinary caller; team routing on and
   off; a provider with only keys and one mixing seats and keys; pool route
   and direct route.
6. Scenario: with admission on (cap 1), a request cancelled before headers
   and one cancelled mid-stream each leave the seat admitting the next
   request at once (permit released, queue empty). The existing
   `provider-cancellation-*` scenarios stay untouched.
7. Websocket cases: a failed initial upstream connect moves to the next
   account; once connected, an upstream failure is not retried on another
   account; no admission permit is taken.
8. Run the new tests green against today's code, then
   `bun test ./src` in `apps/server` and `packages/proxy`, typecheck, Biome.
9. Record the baseline: the list of scenario names and their assertion count,
   pasted in the PR body; later PRs compare against it.

### Task 2: Provider interface and boundary rules (PR 2)

**Files:**
- Create: `packages/capacity/src/routed-provider.ts`
- Modify: `packages/capacity/src/index.ts`
- Modify: `packages/capacity/package.json` (depend on `@agent-smith/types` for `ProviderWire`, `RequestMeta`)
- Modify: `apps/server/src/package-boundaries.integration.test.ts`

1. Add the boundary rules red: `@agent-smith/routing` may not import
   `@agent-smith/pool`, `database`, `providers` or `proxy`; `@agent-smith/pool`
   may not import `routing` or `proxy`.
2. Add the types of the spec's « Provider interface » (`RouteScope`,
   `EdgeRequest`, `RouteRequest`, `Availability`, `ProviderStatus`,
   `ServeOutcome`, `SessionOutcome`, `RoutedProvider`).
3. Typecheck `capacity` and `routing`; run the boundary test.

### Task 3: Create `@agent-smith/pool` behind narrow seams (PR 2)

The moved code reads `ProxyContext` and calls the executor today, and `pool`
may not import `proxy`, so the seams come first.

**Files:**
- Create: `packages/pool/package.json`, `tsconfig.json`, `src/index.ts`
- Create: `packages/pool/src/pool-context.ts`: what the moved code reads
  (`dbOps`, the pool settings view, `providerRegistry`, `asyncWriter`, the
  seat state objects)
- Create: `packages/pool/src/attempt-executor.ts`: the interface the proxy
  implements (send one attempt with one credential, return the attempt and the
  facts it parsed)
- Move from `packages/proxy/src/` with their tests: `handlers/account-selector.ts`,
  `team-admission.ts`, `quota-probe.ts`, `window-warmup.ts`, `seat-alerts.ts`,
  `seat-usage.ts`, `outside-spend.ts`, `handlers/message-thread.ts`,
  `handlers/token-manager.ts`
- Split: `team-router.ts` → seat order, seat pins, `begin`/`end`, `rebind`
  and `eligibleAccounts` to `packages/pool/src/seat-router.ts`;
  `providerConversationKey` and `hasOrderedProviderFallback` stay for task 6
- Modify: `packages/proxy/package.json`, `packages/runtime-server/package.json`,
  `packages/api/package.json` and their imports

1. Write the two seam types; make the code that will move read them instead
   of `ProxyContext` and `proxyWithAccount`, still in `packages/proxy`; green.
2. Move the files with `git mv` so history follows; update imports; the proxy
   injects its executor at bootstrap.
3. Run `packages/pool` and `packages/proxy` tests, the full scenario suite,
   typecheck, Biome, and the boundary test. No scenario file changes.

### Task 4: Pool serves a provider; the executor stops writing account state (PR 2)

**Files:**
- Create: `packages/pool/src/provider-supply.ts` (+ `.test.ts`): one class per
  configured provider implementing `RoutedProvider`, with team rules on when
  the provider has a pool (today: `team_routing.enabled` and members)
- Move: `handlers/proxy-attempts.ts` (account loop, admission, sibling rules)
  → `packages/pool/src/account-attempts.ts`
- Modify: `pool/provider-pool-attempts.ts` (temporary adapter, deleted in task 6)
- Modify: `handlers/proxy-operations.ts`, `handlers/response-processor.ts`
  (stay in proxy: the executor)

1. Write `provider-supply.test.ts` red with a fake executor: each row of the
   spec's outcome mapping table returns the listed `ServeOutcome`, with
   `providerServed` true only for a first-hand account answer; permits are
   released on `final` stream end, on cancel and on every `exhausted`.
2. Implement `serve` by moving `proxySelectedAccounts` and the per-candidate
   part of `proxyPoolCandidate`; `serve` always returns `exhausted` where
   today's code would consult `allowNextProvider`. Until the Router lands,
   `provider-pool-attempts.ts` stays as an adapter that turns `exhausted`
   back into today's next-provider, forward and discard decisions, so PR 2
   ships alone with no behavior change.
3. Make the executor report instead of write. `proxyWithAccount` returns its
   attempt plus what it learned; the Pool persists it with today's timing:

   | Write today (timing) | Moves to |
   |---|---|
   | `team-router.ts:127,305` seat pin create/touch (selection, before upstream); `:248` rebind (sibling served); `:292` prune (on access) | Pool (`seat-router.ts`, task 3) |
   | `team-admission.ts:46,164` queue, permit, active count (before the attempt); release at body end, error or cancel | Pool (moved with the file) |
   | `proxy-operations.ts:155` API-key 401 cooldown; `:225` organization 403 quarantine (at upstream headers) | Pool, from `auth-cooldown` and `quarantine` facts |
   | `response-processor.ts:120,145,163` rate-limit reset, rate-limit meta, quota state + `outsideSpendTracker.observe` (at upstream headers; memory at once, database queued) | Pool, from the parsed limit facts |
   | `token-manager.ts:54,135` account error, refreshed tokens (memory at once, database queued; also called by websocket, probe and warm-up) | Pool (`token-manager.ts` moved in task 3) |
   | `proxy-operations.ts:312` message-thread binding (memory, once the message id is read) | Pool, on a `final` response with a message id |
   | `proxy-attempts.ts:105,106,109,110,133,187,230,234,267,309` in-flight, spend activity, extra-usage alert, switch arming, rebind | Pool (moved with the file) |
   | `quota-probe.ts`, `window-warmup.ts` quota after a reading; warm-up brackets spend activity | Pool (moved in task 3) |
   | `conversation-provider-routing-store.ts:25,55,65` provider preference and blocks | Router's store (task 6) |
   | `post-processor.worker.ts:584` `updateAccountUsage` (worker start) | stays in the worker: a usage counter on its own database handle, not an eligibility input |
   | `api/src/handlers/accounts.ts`, `enrollment.ts`, `oauth-flow` account create, update, pause, reconnect | unchanged: control plane |

4. `classifyUpstreamResponse` takes `inlineRateLimitRetry` instead of reading
   `interactiveProviderChoiceRequested(req.headers)` (`proxy-operations.ts:232`).
5. Full scenario suite, `packages/pool` and `packages/proxy` tests, typecheck.
   Watch `admission-*`, `owner-cap*`, `weekly-cap-*`, `conversation-pinning`,
   `lowest-five-hour-seat`, `expiring-quota-*`, `all-full-blocks-and-alerts`,
   `all-spent-revalidation`, `message-thread-*`, `stream-*`,
   `api-key-401-cooldown`, `organization-403-failover`, `transient-refresh-backoff`.

### Task 5: Wiring, hot reload, websocket and status (PR 2)

**Files:**
- Modify: `packages/runtime-server/src/bootstrap-runtime.ts`
- Modify: `packages/proxy/src/handlers/proxy-types.ts`
- Modify: `packages/proxy/src/websocket-proxy.ts`
- Modify: `packages/api/src/router.ts` (pool status)

1. `bootstrapRuntime` builds one `RoutedProvider` per configured provider and
   passes them to the proxy; `ProxyContext` loses `teamRouter`,
   `teamAdmission`, `quotaProbeAt`, `messageThreads`, `seatAlerts`,
   `outsideSpendTracker`, `refreshInFlight`.
2. Hot reload updates each provider's pool settings in place (today
   `wireStrategyHotReload` reassigns `runtimeConfig.teamRouting` and
   reschedules probe and warm-up); providers are never rebuilt, so admission,
   in-flight counts, refresh deduplication and pins survive. Test a settings
   change during an open stream and during a token refresh.
3. Websocket: `websocket-proxy.ts:688` selects through
   `RoutedProvider.openSession`; it still takes no admission permit and no
   in-flight count, fails over only before the upstream connection opens, and
   the usage worker still records at `response.created` and completion.
   Run `websocket.integration.test.ts`,
   `websocket-request-logging.integration.test.ts`, `websocket-proxy.test.ts`.
4. `/api/pool-status` reads `RoutedProvider.status()`.
5. Full verification: `bun run verify`; real-client check: Claude Code and
   Codex wrappers against the fake upstream, listed in the PR.

### Task 6: `Router.route` (PR 3)

**Files:**
- Create: `packages/routing/src/router.ts` (+ `router.test.ts`)
- Move: `packages/proxy/src/quota-hold.ts` → `packages/routing/src/hold.ts`
- Move: `providerConversationKey`, `hasOrderedProviderFallback` from
  `team-router.ts` → `packages/routing/src/`
- Delete after the move: `packages/proxy/src/provider-pool.ts`,
  `pool/interactive-provider-pool.ts`, `pool/provider-pool-attempts.ts`
- Modify: `packages/proxy/src/proxy.ts` (`handleProxy` calls the Router)

1. Write `router.test.ts` red against fake `RoutedProvider`s: the spec's
   outcome table per caller kind (ordinary, ordered, chooser-capable),
   conversation block recorded and cleared, preference stored only on a
   `final` with `providerServed`, the provider with `holdsConversation`
   first, `discard` called on every abandoned `exhausted`, no provider served
   twice, a `threadRequest` never offered another provider, the interactive
   « Wait » (wait for the block's `retryAt` within `hold_seconds`, retry
   once), a non-interactive pool route that never holds (429 with the
   soonest retry, else 503), the manual chooser, promotion details,
   served-provider headers, the route-full callback, abort during a wait.
2. Implement: one wait helper serving both of today's waits (`handleProxy`'s
   direct-route hold, `waitOrReturnProviderCapacity`), the chooser built from
   `availability()` (advisory), the capacity problem from
   `createProviderCapacityProblem`.
3. `handleProxy` builds the `RouteRequest` and calls the Router for pool
   routes. Golden keys must stay green.
4. Watch the 11 `provider-pool-*` scenarios, `interactive-provider-choice`,
   `chooser-listed-then-blocked`, `pin-and-preference-restart`,
   `hold-on-exhaustion`, `held-thread-waits-for-its-seat`,
   `bounded-failover`, `stream-overload-failover`, `quota-rejection-rotates`,
   `pool-pin-full-fleet-alert`, `provider-choice.test.ts`.

### Task 7: Direct routes and the manual pin (PR 3)

**Files:**
- Modify: `packages/proxy/src/proxy.ts`
- Modify: `packages/routing/src/router.ts`

1. Direct `/v1/<provider>/*` routes call the Router as a one-provider route
   with scope `direct`: the seat hold runs whenever the provider has a pool
   (today: gated by `team_routing.enabled`, same thing before task 10),
   capacity blocks are forwarded, errors unchanged.
2. The manual pin (`/tc-acct/<name>/`) reaches the Pool as `seatHint` on
   both route kinds; the Router passes it on unread.
3. Watch `provider-pool-direct-route`, `manual-pin`, `manual-pin-pool-route`,
   `hold-on-exhaustion`, `passthrough`, `chatgpt-passthrough`.

### Task 8: Caller reach moves to the Router (PR 3)

**Files:**
- Modify: `packages/routing/src/router.ts`
- Modify: `packages/pool/src/account-selector.ts` (`getCallerPoolStatus`,
  `callerPoolAccounts`)
- Delete: `admittedPoolAccounts` (`interactive-provider-pool.ts:50`)

1. Which providers a caller may reach, and whether it may move on, is a Router
   rule; caller ceilings stay in the Pool (spec, « Decisions »).
2. API-key accounts: the Router sets `RouteRequest.apiKeyAccounts` (until
   task 10 from today's config: team routing off, or a chooser-capable header,
   or an ordered caller, on pool routes only); the Pool filters by account
   auth method on every serve, direct and pool routes, for every provider
   with or without a pool, replacing both `admittedPoolAccounts` and the
   direct-route `isAllowlisted` exclusion of keys. The task 1 reach table
   stays green.
3. Caller pool status sums `status()` over the providers the caller reaches.
4. Watch `api-key-account-reach`, `caller-pool-status`, `caller-weekly-cap`,
   `provider-pool-caller-weekly-fallback`, `seat-allowlist`.
5. `bun run verify`; real-client checks listed in the PR.

### Task 9: Second-provider proof (PR 4)

**Files:**
- Modify: `packages/routing/src/router.test.ts`
- Create: `apps/server/src/scenarios/pooled-and-api-key-route.scenario.ts`
- Modify: `packages/api/src/router.ts` (`/api/pool-status`)

1. Router tests over two fake providers the Router cannot tell apart, one
   backed by a fake pool.
2. Scenario: a pooled provider and an unpooled API-key provider serve one
   route through today's `provider_pools`.
3. `/api/pool-status` answers from Router reach plus each provider's
   `status()`; `caller-pool-status` unchanged.

### Task 10: Configuration with its owner, hard switch (PR 5)

**Files:**
- Modify: `packages/config/src/index.ts` (+ tests)
- Modify: `packages/providers/src/configured-registry.ts`
- Modify: `packages/runtime-server/src/bootstrap-runtime.ts`
- Modify: `packages/api/src/handlers/config.ts`, `packages/api/src/router.ts`
  (+ `router.test.ts`)
- Modify: `examples/config/*.json`

1. Config tests red: `providers.<name>.pool` and `routing` (`routes`,
   `api_key_accounts`, `callers.<device>.allow_fallbacks`, `hold_seconds`)
   parse to the spec's shape; a file with `team_routing` or `provider_pools`
   is refused at startup with a message naming the new fields; private maps
   are write-only on the API.
2. Implement. Test the one intentional change: a caller with
   `allow_fallbacks` falls back on a route with no pooled provider.
3. Replace `/api/config/team-routing` with `/api/config/providers/:name/pool`
   and `/api/config/routing`; hot reload keys follow.
4. Rewrite every scenario fixture that sets `team_routing` or `provider_pools`
   to the new shape: fixture edits only, named in the PR, assertions
   untouched. The task 1 reach table is the check that the rewrite rule
   (spec, « Configuration ») keeps behavior.

### Task 11: Two pooled providers of one model (PR 5)

**Files:**
- Create: `apps/server/src/scenarios/two-pooled-providers-one-route.scenario.ts`

1. Two pooled providers of the same wire in one route: seats, pins and
   ceilings stay per provider; the Router moves only for a caller with
   `allow_fallbacks`.
2. Tokens survive: a seat stored under `claude-code` before the switch serves
   after it (database untouched).

### Task 12: Operator scripts and the staged switch (webapp PR, before PR 5 merges)

**Files (webapp repo):**
- Modify: `packages/agents/docker/pool-admin.mjs`, `local-pool.mjs`
- Modify: `packages/agents/test/pool-admin.test.js`, `local-pool.test.js`,
  `scripts/agents/pool.test.mjs`
- Modify: `packages/agents/docs/account-pool.md`

1. `pnpm agents:pool` reads and writes the new endpoints; `local-pool.mjs`
   writes `providers.<name>.pool` and `routing`. Ready and reviewed before
   PR 5 merges; merged right after the switch.
2. A reviewed rewrite of the live config into the new shape, by the spec's
   rule; the owner places it beside the live file on the pool host.
3. Dry run on a copy of the live `pool.db` with the rewritten config, never
   against a real provider: refreshing a copied token would rotate it and
   leave production's copy revoked. Upstream and OAuth refresh point at the
   scenario harness's fake upstream; probe and warm-up off. Check: boot,
   restart, one refresh against the fake endpoint, every seat listed with its
   account id and token fields unchanged. A live canary, if wanted, uses a
   disposable seat the owner authorizes separately.
4. The switch, in quiet hours, owner steps named: pause the standalone pool's
   auto-deploy; merge PR 5; set `AGENT_SMITH_CONFIG_PATH` to the rewritten
   file and deploy; `pnpm agents:pool -- status` lists the same seats; one
   Claude Code and one Codex request through the pool; resume auto-deploy.
   Rollback: point `AGENT_SMITH_CONFIG_PATH` back and redeploy the previous
   commit. Operator writes (allow, warm-up) wait until the switch is done.
5. `account-pool.md` gets the new laptop snippet; the four laptops are edited
   once by hand after the npm release.

### Task 13: Docs and release (PR 6)

**Files:**
- Modify: `docs/architecture.md`, `docs/load-balancing.md`,
  `docs/configuration.md`, `docs/data-flow.md`, `docs/api-http.md`, `README.md`

1. Document the two modules, the provider interface, the new configuration
   and the hard switch with its rollback.
2. Version bump → npm (`release.yml`) → webapp pin bump in
   `packages/agents/docker/pool-release/`; `pnpm agents:pool -- status` after
   the standalone pool redeploys.

---

## Proof rules (every PR)

- No scenario assertion changes; fixture or wiring edits are named in the PR.
- Golden key test and package-boundary test green.
- `bun run verify` once per PR; failures that predate the PR reported by name.
- The real-client checks run, and any that could not run, listed in the PR.

## Review notes

| Reviewer | Point | Outcome |
|---|---|---|
| Codex (independent map) | The websocket path takes no admission permit or in-flight count | Adopted: the spec's draft said it released one; corrected, and task 5 keeps it |
| Codex | Seat pins are written at selection, before the upstream call; usage counters at worker start | Adopted in the task 4 write table |
| Codex | No scenario for pins and preference across a restart, nor for a chooser-listed provider that blocks on serve | Same gaps as ours: task 1 |
| Codex | No permit/queue recovery assertion after a cancellation; no spawned websocket failover case | Added to task 1 |
| Codex | Keeping provider names is necessary, not sufficient, for tokens | Adopted: task 12 dry run on a copied database |
| Claude (code reading) | Pool and direct routes loop accounts differently on a capacity block; « all accounts failed » and the waits differ per route | Spec outcome table corrected; the Pool keeps both loops |
| Claude (code reading) | A manual pin also reaches pool routes | `seatHint`, opaque to the Router; task 1 characterizes it |
| Codex (draft review) | Per-minute retry skipped over 60 s; request-scoped delayed retry only after a second request-scoped answer | Spec table rows corrected |
| Codex | Preference and block clearing only on a first-hand account answer | `ServeOutcome.final.providerServed`; tested in tasks 4 and 6 |
| Codex | `availability()` needs the body (opening digest, thread parse); the Router needs the provider of an existing seat pin; caller status needs counts; the chooser excludes every thread request | `RouteRequest.edge`, `Availability.holdsConversation` and `threadRequest`, `status()`; restart with a seat pin but no preference in task 1 |
| Codex | Task 3 cannot be imports-only | Seams first (`PoolContext`, `AttemptExecutor`); PR 2 +0.5 d |
| Codex | PR 2 removes `allowNextProvider` before the Router exists | Temporary adapter in task 4, deleted in task 6 |
| Codex | Never refresh copied production tokens | Task 12 dry run against the fake upstream only |
| Codex | PR 5 would auto-deploy a version that refuses the live config | Staged switch in task 12: auto-deploy paused, `AGENT_SMITH_CONFIG_PATH` to the new file, rollback by path |
| Codex | `choice_only` is not today's rule: the capability header admits keys, team routing can be off, providers can mix seats and keys, direct routes differ | Replaced by `routing.api_key_accounts` applied by account auth method; reach table in task 1 |
| Codex | Fallback without a pool is a behavior change | Labelled intentional in the spec, tested in task 10 |
| Codex | Hot reload must keep live state | Settings updated in place, tested under an open stream and a refresh (task 5) |
| Codex (final check) | Keys-only providers on direct routes: today team routing excludes their keys there too | API-key reach enforced on every serve, both route kinds, pooled or not (spec « Rules », task 8) |
| Codex (final check) | The pin lookup parses the opening with the first provider, the rebind with the serving one; a precomputed digest in the golden test would miss a drift | `RouteRequest.openingDigest` from the first provider; golden test from raw bodies with two differing parsers (task 1) |
| buy-critic | LiteLLM has session affinity and `disable_fallbacks`; Portkey has `conditional` and `on_status_codes`; TeamClaude and underclass do the same job | Prior-art table corrected and extended; build stands |
| buy-critic | `fallback: "ordered"` is a one-value enum; the standard is a boolean | `routing.callers.<device>.allow_fallbacks` (OpenRouter's name) |
