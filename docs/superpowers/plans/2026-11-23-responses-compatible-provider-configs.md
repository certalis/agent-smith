# Responses-Compatible Provider Configs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested public configuration example for Qwen and Model-Studio-hosted Kimi on the Claude Code and Codex wires, and document provider switching plus local Codex routing.

**Architecture:** Reuse the existing named `anthropic-api`/`openai-api` provider strategies and their same-wire pools. The new JSON example model-maps Claude Code's `claude-sonnet-*` and Codex's `gpt-5.6-*` names to Qwen and Kimi upstream names; no provider code or request translation changes.

**Tech Stack:** JSON configuration examples, Bun tests, Markdown documentation.

**Spec:** `docs/superpowers/specs/2026-11-23-responses-compatible-provider-configs-design.md`

## Global Constraints

- Preserve all bytes except an explicit configured `model` rewrite.
- Keep examples public-safe: no credentials, workspace IDs, private origins, or account identities.
- Do not represent direct Kimi Chat Completions as Responses-compatible.
- Do not edit the pre-existing user changes in `README.md`.

## Review Focus

- The copied configuration maps only the explicit Claude Code and Codex model prefixes; test all four maps rather than assuming arbitrary models pass through.
- The example pool ordering is Qwen then Kimi; test both orders because fallback behavior depends on them. Document that an already-authorized subscription provider is added separately as the first entry.
- Kimi is Model Studio-hosted, not direct Kimi; state that boundary in the guide.
- A switch never rewrites a live conversation by operator preference; document that affinity/failover decides it.
- Local Codex project configuration cannot redirect a provider; point users to the launch wrapper or user-level configuration.

---

### Task 1: Add the tested provider example

**Files:**
- Create: `examples/config/model-studio-compatible-providers.json`
- Modify: `packages/config/src/providers.test.ts`

**Interfaces:**
- Consumes: `Config.getProviderConfig(name)` and `Config.getProviderPool("openai-responses")`.
- Produces: A parseable public example with Qwen and Kimi provider definitions for both supported wires.

- [x] **Step 1: Write the failing example test**

Add `model-studio-compatible-providers.json` to the API-key example list. Assert that its two pools order Qwen then Kimi. Assert that the Claude providers map `claude-sonnet-*` to `qwen3-coder-flash` and `kimi-k3.1-pro`, while the Codex providers map `gpt-5.6-*` to `qwen4-max` and `kimi-k3.1-pro`.

- [x] **Step 2: Run the targeted test to verify it fails**

Run: `bun test packages/config/src/providers.test.ts`

Expected: FAIL because `model-studio-compatible-providers.json` does not exist.

- [x] **Step 3: Create the minimal public-safe JSON example**

Define the four configured providers using the Model Studio Anthropic and Responses base URLs, exact model maps from the design, and the two ordered same-wire pools.

- [x] **Step 4: Run the targeted test to verify it passes**

Run: `bun test packages/config/src/providers.test.ts`

Expected: PASS with the new configuration assertions collected.

### Task 2: Document setup and the switching experience

**Files:**
- Modify: `docs/configuration.md`

**Interfaces:**
- Consumes: `examples/config/model-studio-responses.json` and the provider-pool routing contract.
- Produces: An operator-facing explanation of setup, direct-Kimi exclusion, switch behavior, and Codex-local routing.

- [x] **Step 1: Add the Model Studio example to the configuration guide**

Link the example, say it needs an API-key account for each configured provider, and say using one key twice does not add capacity.

- [x] **Step 2: Describe the switch behavior in plain language**

State that Agent-smith selects the first compatible provider for a new request; it keeps an eligible active conversation on its existing account, changes only after ineligibility/failover, and a provider change loses prompt-cache warmth and may change behavior or cost.

- [x] **Step 3: Document the Codex-local boundary**

State that the Agent-smith wrapper passes a temporary provider configuration to Codex when routing is enabled; permanent provider settings belong in user-level `~/.codex/config.toml`, never a repository `.codex/config.toml`.

- [x] **Step 4: Check the changed documentation references**

Run: `rg -n "model-studio-compatible|qwen-claude|kimi-codex|gpt-5.6" examples/config packages/config/src/providers.test.ts docs/configuration.md`

Expected: the example, its test assertions, and documentation references all resolve.
