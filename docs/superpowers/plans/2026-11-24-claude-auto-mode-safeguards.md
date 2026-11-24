# Claude Auto Mode Safeguards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Claude Code Auto-mode server safeguards through a pooled Claude OAuth route.

**Architecture:** The native Claude Code provider adds its OAuth beta capability to the open client beta list. The existing raw Messages route remains responsible for carrying the safety body field and result field untouched.

**Tech Stack:** TypeScript, Bun tests, native Fetch/Headers.

**Spec:** `docs/superpowers/specs/2026-11-24-claude-auto-mode-safeguards-design.md`

## Global Constraints

- Preserve every caller `anthropic-beta` value exactly once.
- Do not emulate safety verdicts or route a safety request to another provider.
- Test the observable native proxy contract, not private helper calls alone.

## Review Focus

- A caller beta value is retained alongside the OAuth marker.
- A marker already supplied by the client is not duplicated.
- The complete `safeguards` body object reaches the native upstream.
- The complete `safeguard_results` object reaches Claude Code.
- A translated provider remains out of scope and receives no false support claim.

### Task 1: Preserve native Claude Auto-mode safeguards

**Files:**
- Modify: `packages/providers/src/providers/claude-code/provider.ts`
- Modify: `packages/proxy/src/proxy.test.ts`

**Interfaces:**
- Consumes: an Anthropic Messages request with `anthropic-beta` and a top-level `safeguards` field.
- Produces: a native Claude OAuth request whose beta header includes `oauth-2025-04-20`, with the upstream response forwarded intact.

- [x] **Step 1: Write the failing proxy integration test**

Create a pooled `claude-code` request with `anthropic-beta: server-safeguards-2026-11-01` and a literal `safeguards` object. Assert the recorded native upstream request retains that object and includes both beta values; return a literal `safeguard_results` object and assert the client receives it unchanged.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `bun test packages/proxy/src/proxy.test.ts --test-name-pattern "preserves Claude Code server safeguards"`

Expected: FAIL because the upstream beta header lacks `oauth-2025-04-20`.

- [x] **Step 3: Merge the OAuth beta value in `ClaudeCodeProvider.prepareHeaders`**

Add `oauth-2025-04-20` to the comma-separated `anthropic-beta` header, preserving caller values and de-duplicating it.

- [x] **Step 4: Run focused provider and proxy tests**

Run: `bun test packages/providers/src/providers/claude-code/provider.test.ts packages/proxy/src/proxy.test.ts`

Expected: PASS.

- [x] **Step 5: Run project verification and commit**

Run: `bun run verify`

Expected: PASS, or report each unrelated environmental failure precisely.
