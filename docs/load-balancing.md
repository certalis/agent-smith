# Load balancing in ccflare

## Routing model

ccflare orders eligible accounts for each provider-native request. A direct
`/v1/<provider>/*` route stays with that provider. A configured
`/v1/pool/<wire>/*` route starts with its first compatible provider and may
make one bounded move to the next compatible provider. It does not create a
fleet-wide sticky account: that legacy behavior would override quota and
operator priority decisions.

For a request, the proxy:

1. filters accounts by provider, pause state, temporary cooldown, and fresh
   quota windows relevant to the requested model (with a pooled hard cap kept
   through a still-unreset stale window);
2. if every account is quota-blocked, refuses the request with a 429 naming the
   soonest reset and alerts once (see `alerts`); only with
   `block_when_all_full: false` does it instead permit one real revalidation
   probe per provider per minute, choosing the nearest weekly reset, which may
   spend extra usage;
3. orders the remaining accounts by configured `priority`, then by the nearest
   applicable weekly reset — an order that does not move with usage, so
   unpinned traffic stays on its account; and
4. hands that ordered list to the compatibility-named `SessionStrategy`, which
   currently only filters unavailable accounts.

An account-specific `switch_threshold` overrides the fleet threshold for its
own quota bucket. Reset quota observations do not block a request. A stale
observation ordinarily does not block, except that a pooled seat with a quota
rejection or at or above its hard `max_usage` remains blocked until that window
resets.
A rejected family-specific weekly bucket excludes only that model family.

## Team routing (opt-in)

`team_routing.enabled` is off by default. When enabled, only OAuth seats whose
stored account UUID is on `allowlisted_account_uuids` can receive pooled
traffic. A protected seat is never a fallback.

For Claude Code traffic, a conversation pin is the session ID plus a hashed
digest of its opening, scoped to the model's weekly family. Pins are durable,
so a restart does not move a conversation. The account remains pinned until it
is ineligible; a per-minute 429 does not rotate it. New pinned conversations
choose, in the best priority tier, the lowest 5-hour usage, then the lowest
weekly usage and the nearest weekly reset. The hard quota cap is checked before
that ordering, so no seat at its limit is selected. A
5-hour window whose reset has passed counts as unused. Fewer active pins, then
fewer in-flight requests, only break an exact tie.
Moving a running conversation early would discard its prompt cache, so usage
never moves a pin. Turning `distribution_enabled` off drains pins: existing
conversations stay put while new ones use normal ordering.

Pooled seats have a hard `max_usage` ceiling (never above `0.9`) across their
applicable 5-hour and weekly windows. It applies to ordinary selection and the
once-per-minute revalidation path. If every pooled seat is spent, a request
normally receives a 429 with the nearest reset; setting `hold_seconds` lets a
request wait only for a reset within that bounded period.

The admission gate is per account: it has a configured concurrent-request cap,
FIFO bounded queue, and bounded wait. A quota failover opens its sibling at one
slot, then adds one slot every 250 ms for 30 seconds. `/tc-acct/<name>/...`
selects exactly that allowed, eligible seat and never bypasses the cap or gate.

`quota_probe_seconds` is an opt-in zero-spend read of Anthropic's fixed OAuth
usage endpoint for direct allowlisted Claude Code seats. It never uses a custom
upstream. Fresh weekly readings also feed the outside-spend view in
`GET /api/status`; an interval that overlapped proxy traffic is reported as
`not_measurable`, never as a misleading zero.

## Provider pools

`provider_pools` is an ordered list of enabled providers for one wire protocol:
`anthropic-messages` or `openai-responses`. A pool never translates between
those protocols. Each provider may optionally declare the client model names it
serves and the upstream name to send. Selecting that provider changes only the
JSON `model` value in place; all other request bytes stay untouched.

A pool pin keeps a conversation on its prior account while that account is
eligible. Moving to another provider loses prompt-cache warmth and can change
model behavior or cost, so request and usage records report the provider and
model that actually served the request. Direct routes do not use provider-pool
fallback. If no provider in a pool serves the requested model, the proxy returns
`400` naming `provider_pools.<wire>`; add a matching model map or select a
direct provider route intentionally.

## Affinity and failover

The one W2 affinity is Claude message-thread continuation. A valid
`thread.previous_message_id` plus the same Claude Code client session is sent
to the account that created that upstream message. Bindings are process-local,
expire after one hour, and are capped; an expired binding falls back to normal
account selection. This preserves the upstream thread contract without
claiming W3 conversation pinning.

The selected account is tried first. Failover is deliberately bounded:

- unified quota rejection: one eligible sibling;
- headerless request-scoped 429: one sibling, then one delayed retry there;
- per-minute 429 with `Retry-After`: retry the same account only;
- 5xx, 529, or a classified failure at the start of a streamed `200`: one
  sibling;
- transport failure: one sibling.

For a pool route, the next compatible provider replaces the ordinary
all-accounts-spent response. A 5xx, 529, or failure found before the first
streamed byte may use that next provider only when the current provider has no
eligible sibling. The request never first tries a sibling and then walks to a
second provider. A per-minute 429 always remains on its current provider.

No branch may silently reach a third account.

## Configuration compatibility

`lb_strategy: "session"` remains the only accepted strategy name for API and
configuration compatibility. In W2 it does not create a five-hour sticky
session. `session_duration_ms` is likewise retained as a legacy configuration
field and does not affect account choice. Do not use either setting to infer
conversation affinity.

The compatibility strategy name remains unrelated to team routing.
