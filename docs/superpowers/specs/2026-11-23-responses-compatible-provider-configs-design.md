# Responses-Compatible Provider Configs Design

## Intent

Give an operator a safe, copyable starting point for using Qwen and other
Alibaba Model Studio models through Agent-smith with both Claude Code and
Codex. Do not claim that a provider works when it needs a protocol translation
the proxy does not make.

## Goals

- Add one complete, public-safe configuration example for Qwen and
  Model-Studio-hosted Kimi in both supported wire formats.
- Map known Claude Code and Codex model names to each upstream model without
  changing any request field other than `model`.
- Explain what switching feels like: an active conversation stays assigned only
  with a valid provider/session pin; otherwise, later requests follow normal
  pool selection.
- Explain that the existing local Codex wrapper supplies its provider settings
  at launch, rather than adding a permanent project configuration.

## Non-goals

- No direct Kimi Chat Completions API configuration, which does not match
  Agent-smith's `openai-responses` wire.
- No request/response translation, automatic discovery, quota semantics, or
  new provider strategy.
- No credentials, workspace IDs, private origins, or account identities in
  the example.

## Approaches

1. Add Qwen and direct Kimi Chat Completions as ordinary `openai-api`
   providers. Rejected: that endpoint accepts Chat Completions rather than
   Responses, so this would be a broken configuration.
2. Add a format translator for direct Kimi. Rejected: it changes the proxy
   contract, contradicts the wire-preserving kernel, and is outside this
   documentation-sized change.
3. Add a Model Studio Responses example. Chosen: the upstream accepts
   Responses for Qwen and its hosted Kimi models, so Agent-smith can use its
   existing named `openai-api` configuration and in-place model map.

## Design

Create `examples/config/model-studio-compatible-providers.json`. It defines
four enabled providers, two for each wire:

- `qwen-claude` and `kimi-claude` use `anthropic-api`, Model Studio's
  Anthropic-compatible base URL, and map `claude-sonnet-*` to
  `qwen3-coder-flash` and `kimi-k3.1-pro` respectively.
- `qwen-codex` and `kimi-codex` use `openai-api`, the Responses base URL, and
  map `gpt-5.6-*` to `qwen4-max` and `kimi-k3.1-pro` respectively.

The example's `anthropic-messages` and `openai-responses` pools each order
Qwen then Kimi. An operator who has separately enabled an authorized Claude
Code or Codex subscription provider adds it as the first entry in its matching
pool. This preserves the default safety rule: the example itself does not turn
on subscription sign-ins. The public URLs in the example target Beijing, so the
operator adds a Beijing Model Studio API-key account to each configured provider.
For another region, they replace both the endpoint and API key with that
region's matching pair. Reusing one key under multiple provider names does not
create extra capacity; it only chooses a different model.

Add the example to the configuration test's API-key example list and assert the
four model maps and ordered pools. Document its use in the configuration guide,
including the wire limitation and the plain-language switch behavior.

## Constraints

- Preserve byte-identical requests except the explicit `model` rewrite.
- Keep the example generic and public-mirror safe.
- Do not edit existing user-owned README changes; add the new documentation to
  the clean configuration guide instead.
