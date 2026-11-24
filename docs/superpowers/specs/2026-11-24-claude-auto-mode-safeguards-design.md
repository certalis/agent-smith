# Claude Auto Mode Safeguards Design

## Intent

Let Claude Code use Anthropic's no-charge server-side Auto-mode safety checks
through Agent-smith when Agent-smith selects a pooled Claude Code OAuth seat.

## Goals

- Preserve Claude Code's `anthropic-beta` values and `safeguards` request body
  unchanged on the native Claude route.
- Add the required OAuth capability marker when Agent-smith replaces a caller
  API key with a selected Claude Code OAuth token.
- Return the upstream `safeguard_results` response field unchanged.
- Prove the behaviour with an end-to-end proxy test.

## Non-goals

- Do not emulate Anthropic safeguard decisions.
- Do not claim server-side Auto-mode support for Google, Qwen, Kimi, or other
  translated adapters.
- Do not change model/provider choice, account selection, or fallback policy.

## Approaches

1. Add the OAuth beta marker only on the native Claude Code provider and keep
   the existing raw Messages pass-through. Chosen: it meets Anthropic's
   protocol without changing routing or inventing safety verdicts.
2. Emulate `safeguard_results` in Agent-smith. Rejected: Agent-smith is not
   Anthropic's safety classifier and must not manufacture its decision.
3. Disable server-side Auto mode on every client. Rejected: it retains the
   charged fallback and will stop working when Claude Code removes that path.

## Design

`ClaudeCodeProvider.prepareHeaders` will merge `oauth-2025-04-20` into the
comma-separated `anthropic-beta` header after it installs the pooled OAuth
bearer token. It will preserve every caller-supplied beta value and avoid a
duplicate marker. The raw request and response bodies remain untouched by the
native provider; a proxy integration test will verify the safety request pair
and the returned verdict survive the full path.
