# Example configurations

> [!WARNING]
> The two `example-only-*` files enable a **subscription sign-in** (Claude Code
> or Codex). They exist only to show the config shape. They are not a
> recommendation, and agent-smith makes no claim that the use they enable is
> allowed: Anthropic's and OpenAI's terms, quoted in the
> [main README](../README.md#subscription-sign-ins-and-provider-terms), restrict
> it. Read those terms before copying either file. Enabling a sign-in is your
> decision and your responsibility.

Nothing in this folder is loaded automatically. Copy one file to your config
path (`~/.config/ccflare/ccflare.json`, or the path in `ccflare_CONFIG_PATH`)
and restart agent-smith.

| File | What it does |
|---|---|
| [`config/anthropic-api-key.json`](config/anthropic-api-key.json) | Claude Code uses your Anthropic API key account. |
| [`config/openai-api-key.json`](config/openai-api-key.json) | Codex uses your OpenAI API key account. |
| [`config/compatible-endpoint-fallback.json`](config/compatible-endpoint-fallback.json) | Claude Code uses Anthropic first, then an Anthropic-compatible endpoint for Sonnet models. |
| [`config/example-only-claude-code-subscription.json`](config/example-only-claude-code-subscription.json) | **Example only.** Enables the Claude Code subscription sign-in. |
| [`config/example-only-codex-subscription.json`](config/example-only-codex-subscription.json) | **Example only.** Enables the Codex (ChatGPT) sign-in. |
