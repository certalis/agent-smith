# Interactive Claude-compatible provider choice implementation plan

> **Execution:** The owner said “go” in this chat. Implement directly in the
> current checkout; do not create a worktree or delegate to subagents.

**Goal:** Let a person using Claude Code choose a configured compatible provider
when capacity blocks a turn, with an honest reason, a correct in-session model
indicator, durable pin/decline behavior, and no silent switch.

**Architecture:** Add a narrow Model Studio Anthropic-compatible adapter for
documented limit classification. Add a validated, opaque conversation provider
preference alongside the existing durable account pin. In the pool proxy,
interactive Claude requests receive a structured capacity block instead of
automatic provider fallback; a local Claude Code companion turns the block into
buttons and retries the original turn with an allowlisted choice. The wrapper
loads the companion and a non-invasive status integration.

**Tech stack:** Bun/TypeScript, SQLite migrations/repositories, existing proxy
scenario harness, Claude Code plugin/mod APIs, shell wrappers.

---

### Task 1: Add an honest provider block taxonomy

**Files:**
- Create: `packages/providers/src/provider-block.ts`
- Create: `packages/providers/src/provider-block.test.ts`
- Modify: `packages/providers/src/types.ts`
- Modify: `packages/providers/src/providers/anthropic/provider.ts`
- Create: `packages/providers/src/providers/model-studio/provider.ts`
- Create: `packages/providers/src/providers/model-studio/provider.test.ts`
- Modify: `packages/providers/src/configured-registry.ts`

1. Write focused tests that demonstrate classification of every documented
   Model Studio code, unknown fallbacks, bounded JSON parsing, and optional
   upstream `Retry-After`.
2. Run the provider test first and observe its expected red failure.
3. Implement a provider-owned block descriptor and Model Studio strategy. Do
   not change generic Anthropic fallback timing; delete no upstream error body.
4. Rerun focused tests, then package typecheck and Biome.

### Task 2: Persist conversation provider choice and promotion refusal

**Files:**
- Modify: `packages/database/src/migrations.ts`
- Create: `packages/database/src/repositories/conversation-provider-preference.repository.ts`
- Create: `packages/database/src/repositories/conversation-provider-preference.repository.test.ts`
- Modify: `packages/database/src/database-operations.ts`
- Modify: `packages/proxy/src/team-router.ts`
- Modify: `packages/proxy/src/team-router.test.ts`

1. Write migration/repository tests for an opaque-key preference, upsert,
   promotion-decline persistence, 30-day cleanup, and account cleanup.
2. Observe red; add the migration/repository and facade methods.
3. Write router tests for applying choice, recording a one-time decline, and
   clearing that decline only on an explicit chooser/block event.
4. Observe red; implement the smallest router API needed for those tests.
5. Run database/proxy tests, typechecks, and formatting.

### Task 3: Make pool capacity blocks selectable—not automatic—for supported Claude sessions

**Files:**
- Create: `packages/proxy/src/provider-choice.ts`
- Create: `packages/proxy/src/provider-choice.test.ts`
- Modify: `packages/proxy/src/provider-pool.ts`
- Modify: `packages/proxy/src/handlers/proxy-attempts.ts`
- Modify: `packages/proxy/src/handlers/proxy-request.ts`
- Modify: `packages/runtime-server/src/proxy-edge.ts`
- Create: `apps/server/src/scenarios/interactive-provider-choice.scenario.ts`
- Modify: `apps/server/src/scenarios/index.ts` (or the scenario registration
  file actually used by the harness)

1. Write unit/scenario tests that prove: ranked eligible options; blocked
   provider excluded; control header never reaches upstream; bad/stale choices
   fail closed; selected choice reuses the original body; no automatic fallback;
   normal noninteractive requests keep bounded behavior; promotion refusal
   suppresses repeated notices; explicit reopen and a later pin block restore
   all choices; and thread continuations are wait-only.
2. Observe every new scenario red before proxy edits.
3. Add versioned problem details and validated response/request control
   headers. Feed Model Studio reason/retry data through exactly once. Preserve
   existing one-hop semantics for noninteractive routes.
4. Run all proxy scenarios because routing behavior changed, plus narrow tests
   and typechecks.

### Task 4: Build and load the Claude Code companion and truthful status indicator

**Files:**
- Create: `apps/tui/src/claude-companion/` (manifest, mod, status command,
  state reader/writer, tests)
- Modify: `apps/tui/src/core/local-routing.ts`
- Modify: `apps/tui/src/core/local-routing.test.ts`
- Modify: `apps/tui/src/core/run-helper.ts`
- Modify: `README.md`
- Modify: `docs/configuration.md`

1. First create a supported-Claude-Code smoke test/plugin fixture that proves
   the mod receives an Agent-smith capacity response, renders an out-of-band
   chooser, puts its selected control header on the retried request, and
   records the actual successful provider/model. The fixture must not rely on
   assistant-message injection.
2. Run it red. If installed Claude Code's supported mod API cannot replay a
   failed turn, stop at this task and report the concrete API limitation rather
   than faking the interaction.
3. Implement companion state and status command. It owns only its files,
   preserves an existing statusLine command, and has a reversible wrapper
   install/uninstall path.
4. Implement menu behavior: ranked models plus Wait; a one-time recovery
   offer; decline silence; re-open on pinned-model block or explicit user
   request.
5. Run companion/wrapper tests, `bun run build:tui`, typecheck and Biome.

### Task 5: Document and verify the full safety boundary

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/load-balancing.md`
- Modify: `docs/providers.md`
- Modify: `docs/data-flow.md`
- Modify: `examples/config/model-studio-compatible-providers.json`

1. Document the actual UX, no-auto-switch guarantee, configured-order ranking,
   truthful limit categories, unknown timing behavior, thread constraint,
   statusline fallback, Model Studio endpoint boundary, and the interactive vs
   unattended distinction.
2. Check that all docs point to real files and no copied configuration exposes
   credentials.
3. Run `bun run verify` once. Report pre-existing or sandbox-limited failures
   separately, by name.
