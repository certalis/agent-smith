# Provider routing boundaries implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the provider chooser's routing, capacity, pool, connector, and
companion responsibilities explicit without changing its behavior.

**Architecture:** Create small `@agent-smith/capacity` and `@agent-smith/routing`
packages. The proxy's pool code implements routing's opaque state interface;
the provider package remains the connector boundary and produces capacity
facts. The Claude companion remains an HTTP/UI client of routing.

**Tech Stack:** Bun, TypeScript, SQLite facade, existing proxy scenario
harness, Claude companion plugin.

**Spec:** `docs/superpowers/specs/2026-11-23-provider-routing-boundaries-design.md`

## Global Constraints

- Keep the current interactive chooser behavior and native provider payloads.
- Routing cannot import database or provider packages.
- Capacity cannot import account, database, or connector packages.
- No real-provider request in automated tests.

## Review Focus

- A selected provider remains pinned after the state implementation moves.
- A rejected promotion remains silent after the state implementation moves.
- An unknown upstream block cannot become a recovery offer.
- Private chooser headers never reach an upstream connector.
- A normal, noninteractive pool keeps its existing bounded fallback.

### Task 1: Extract capacity facts

**Files:** Create `packages/capacity/`; modify `packages/providers/` and
`packages/proxy/` imports.

**Interfaces:** Produces `ProviderCapacityBlock` and
`ProviderBlockCategory` from `@agent-smith/capacity`.

- [x] Write a failing capacity-package test for a block vocabulary that has no
  provider dependency.
- [x] Move the shared block types to `@agent-smith/capacity`; leave Model Studio
  parsing in the provider connector.
- [x] Run capacity/provider/proxy tests and typechecks.

### Task 2: Extract routing policy and state interface

**Files:** Create `packages/routing/`; modify provider-choice tests and proxy
imports.

**Interfaces:** Produces `ConversationProviderRoutingStore` and
`ConversationProviderRouting`, consumed by the pool implementation.

- [x] Write failing routing tests for selected-provider persistence, declined
  promotion, and an unknown upstream block.
- [x] Move private chooser protocol and conversation preference/block policy
  into `@agent-smith/routing` with no database/provider imports.
- [x] Run routing tests and typecheck.

### Task 3: Make the proxy pool the concrete routing state source

**Files:** Create `packages/proxy/src/pool/`; modify `provider-pool.ts` and
proxy integration tests.

**Interfaces:** Consumes `ConversationProviderRoutingStore`; implements it
through `DatabaseOperations`.

- [x] Write a failing proxy test proving the moved state source preserves the
  configured provider pin and wait category without a second upstream call.
- [x] Replace chooser-specific `dbOps` calls in `provider-pool.ts` with the
  pool-owned state source and routing policy.
- [x] Run proxy tests, all proxy scenarios, and formatting.

### Task 4: Document boundaries and smoke test

**Files:** Modify architecture/data-flow/provider docs and the existing
chooser design/plan as needed.

- [x] Document the one-way boundaries and reserve adapters for the Google
  canonical-protocol slice.
- [x] Start a local fake-upstream scenario through the real server and verify
  chooser response/status headers without credentials.
- [ ] Run `bun run verify`, build the TUI, review the branch, then ship.
