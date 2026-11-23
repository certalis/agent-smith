# Interactive Claude-compatible provider choice

## Goal

When the current provider in an Anthropic-compatible Agent-smith pool cannot
serve a Claude Code turn, Claude Code asks the person before the proxy changes
provider. The person chooses a capable provider or **Wait**; the proxy never
silently substitutes one.

This is deliberately a Claude Code companion feature. It does not change
Codex, direct provider routes, the dashboard, or the existing TUI.

## Interaction contract

1. The proxy detects that the active provider cannot serve the request before
   returning any upstream byte. It returns a structured Agent-smith capacity
   block, rather than walking to the next provider for this interactive route.
2. The companion renders an out-of-band chooser in the current Claude Code
   session. It contains every eligible provider for the requested model in the
   `provider_pools.anthropic-messages` order, then **Wait**. The currently
   blocked provider is absent. The message identifies the actual condition:
   5-hour/weekly quota, request rate, token allocation, burst, temporary
   capacity, or an explicitly unknown upstream reason. It shows a deadline only
   when Agent-smith received one.
3. Selecting a provider retries the original request exactly once with an
   authenticated, validated choice header. Agent-smith changes only the mapped
   JSON `model` field as already permitted by the kernel; request content and
   context stay intact. The selected provider becomes the durable provider pin
   for that conversation.
4. **Wait** holds the same turn against its pinned provider only when a
   provided deadline falls within the configured server-side hold window. If
   there is no trustworthy deadline, the companion says so and does not repeat
   the request or invent a countdown.
5. If a provider earlier in configured pool order becomes eligible, the
   companion presents one upgrade offer on the next turn. An acceptance moves
   the pin; a refusal records a decline. There are no further upgrade offers
   until the pinned provider blocks or the person runs
   `/agent-smith-provider`, which opens the complete ranked chooser on the
   next turn.
6. A Claude message-thread continuation remains on the account/provider that
   owns its upstream thread. If that provider is unavailable, its chooser is
   wait-only; it must never offer a move that would cause an upstream
   `thread_not_found`.

## Accurate capacity information

`anthropic-api` remains generic. A distinct, Model-Studio-only
Anthropic-compatible provider strategy parses only documented response
information:

- request rate: `Throttling.RateQuota`;
- token allocation: `Throttling.AllocationQuota`;
- burst: `Throttling.BurstRate`;
- dynamic throughput: `Throttling.ResourceExhausted` or
  `Throttling.ServiceOverloaded`.

The adapter preserves the upstream response body and uses a bounded clone for
classification. Missing or unfamiliar codes become `unknown`, and no retry
time is synthesized. `Retry-After` or an explicit reset is the only source of
a wait deadline. This is classification, not a third-party quota reader or
polling service.

## Server contract

The proxy owns provider eligibility and validates all client choices. The
companion never supplies an arbitrary upstream URL, provider, model mapping,
or timing decision. It sends a short choice token only on an Agent-smith pool
route. The proxy removes that control header before forwarding and accepts it
only when the named provider is configured for the same wire, serves the
requested model, and is currently eligible.

The durable conversation preference is keyed by Agent-smith's already opaque
conversation pin key. It stores the selected provider plus whether a higher
provider promotion was declined. A separate tiny block record prevents an
upstream limit with no recovery time from being promoted as if it cleared. Both
share the existing 30-day pin expiry and store neither session IDs nor prompts.
They are removed with the pin/account cleanup.

Responses use a versioned `application/problem+json` Agent-smith envelope and
private response headers so the supported companion can recognize the block
without parsing natural-language error text. Normal Claude clients retain a
plain, useful 429 response. The envelope carries only provider display labels,
category, optional retry time, and eligible choices—never account IDs,
credentials, or quota percentages.

## Claude Code integration

The generated wrapper loads an Agent-smith companion plugin only for Claude
Code sessions. It uses the supported mod request hook to recognize an
Agent-smith capacity block, display buttons, and retry the blocked turn. The
out-of-band dialog and status row are not model context or assistant messages.
The companion sets its own Claude Code status row to `Agent-smith: <provider>
· <model>` using factual response headers; it does not modify a user's
statusline configuration.

## Non-goals and safety limits

- No automatic provider migration for interactive Claude Code sessions.
- No model-quality inference: configured pool order is the sole ranking.
- No direct Kimi API integration; Kimi is Model Studio-hosted in this slice.
- No Codex work, dashboard/TUI work, pricing policy, account polling, or
  provider quota scraping.
- No move after a streamed byte or for an upstream message-thread continuation.
- Unattended clients keep the current bounded pool behavior; they cannot
  accidentally enter a UI-dependent hold.
