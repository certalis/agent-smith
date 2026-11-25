# Load balancing in agent-smith

## Routing model

agent-smith orders eligible accounts for each provider-native request. A direct
`/v1/<provider>/*` route stays with that provider. A configured
`/v1/pool/<wire>/*` route starts with its first compatible provider. It changes
provider only after a wrapped Claude Code user chooses one, or for a named
unattended device with the private ordered-fallback policy. It does not create
a fleet-wide sticky account: that legacy behavior would override quota and
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

OAuth expiry alone does not exclude an account: the proxy refreshes it before
use. A rejected refresh (4xx other than 408 or 429) pauses the account with an
error reason, including when expiry or a background probe triggered it. An
operator must repair its credentials before resuming it. Transient refresh
failures instead exclude it for the existing 60-second refresh backoff; capacity
status uses the same exclusion. Backoff is a credential failure, not a transport
failure that starts a sibling's admission ramp.

## Provider pools (opt-in)

Each `providers.<name>.pool` opts that provider into sharing. It is off when
absent or when `enabled: false`; otherwise only OAuth seats whose stored UUID
is in that pool’s `members` are eligible. A protected seat is never a fallback.

For Claude Code traffic, a conversation pin is the named caller (when one is
authenticated), session ID and a hashed digest of its opening, scoped to the
model's weekly family. Pins are durable, so a restart does not move a
conversation or let another caller inherit it. The account remains pinned until
it is ineligible; a per-minute 429 does not rotate it. New pinned conversations
choose, in the best priority tier, the lowest 5-hour usage, then the lowest
weekly usage and the nearest weekly reset. The hard quota cap is checked before
that ordering, so no seat at its limit is selected. A
5-hour window whose reset has passed counts as unused. Fewer active pins, then
fewer in-flight requests, only break an exact tie.
Moving a running conversation early would discard its prompt cache, so usage
never moves a pin. Turning `distribution_enabled` off drains pins: existing
conversations stay put while new ones use normal ordering.

`prefer_expiring_quota` is an optional new-chat preference, off by default.
Within the best priority tier, it first favors the earliest applicable quota
reset within 1 hour for a 5-hour window, or 24 hours for a weekly window. The
reading must be fresh (at most 30 minutes old), have a known remaining fraction
and future reset, and apply to the requested model. Otherwise normal usage
ordering wins. Equal reset times use the ordinary usage and load tie-breakers.
This does not predict consumption, borrow capacity or raise a cap. Existing
conversation pins, manual account selection and message-thread affinity do not
move. Accounts paused, excluded or at any applicable cap stay ineligible.
Without a conversation key, or with distribution disabled, this option has no
effect. The same rule applies to Claude Code and Codex pinned conversations.

Pooled seats keep their `max_usage` ceiling (never above `0.9`) for 5-hour and
other non-weekly windows. Weekly windows use `weekly_max_usage` (default `0.95`)
unless `weekly_max_usage_by_email` sets an explicit ceiling for one account.
`caller_weekly_max_usage` remains an additional, lower ceiling for one named
authenticated device.
For example, Alice at `0.70` skips a seat at 70% weekly use while an
unconfigured caller may still use that seat through 95%; a lower account cap
still applies to both. These are eligibility rules, not separate spend counters.
They cover applicable model-family weekly windows, ordinary selection and the
once-per-minute revalidation path. If every pooled seat is spent for that
caller, a request normally receives a 429 with the nearest reset; setting
`routing.hold_seconds` lets a request wait only for a reset within that bounded period.

`routing.callers.<device>.allow_fallbacks` is a separate private policy for a
named unattended device. When `true`, it starts at the current provider and may
continue only to later providers in the configured order after a block; it never
wraps back to a higher-ranked provider. API-key accounts at those later providers
keep their ordinary account rules; this policy does not add provider-specific
ceilings. No other caller, including an interactive Claude Code session, gets an
automatic provider switch. The same device in an interactive Claude Code session
keeps the chooser instead of the automatic walk. With `routing.api_key_accounts: "chooser_or_fallback"`, API-key accounts serve
that walk and chooser-capable requests; an unattended caller without the
policy cannot reach them. The `everyone` setting allows ordinary key reach.

The admission gate is per account: it has a configured concurrent-request cap,
FIFO bounded queue, and bounded wait. A quota failover opens its sibling at one
slot, then adds one slot every 250 ms for 30 seconds. Repeated arrivals share
that ramp rather than restarting it; an already-serving sibling never has its
capacity reduced by another arrival. `/tc-acct/<name>/...`
selects exactly that allowed, eligible seat and never bypasses the cap or gate.

Admission rejections (503 queue-full or wait-timeout, before any provider call)
include `Retry-After: 1`, then `10`, then `30` seconds, according to the client's
`x-stainless-retry-count` header (missing or invalid means the first attempt).
Later retries stay at 30 seconds. Supporting clients decide whether to retry
within their own retry budget; the proxy never replays a model response or
changes the configured admission wait to implement this delay.

`quota_probe_seconds` is an opt-in zero-spend read of Anthropic's fixed OAuth
usage endpoint for direct allowlisted Claude Code seats. It never uses a custom
upstream. Fresh weekly readings also feed the outside-spend view in
`GET /api/status`; an interval that overlapped proxy traffic is reported as
`not_measurable`, never as a misleading zero.

`window_warmup` is opt-in too: at configured local times it starts the
five-hour window of each direct allowlisted seat whose window is not running
and that is under its cap, with one minimal message on that seat's own
credentials. It moves no conversation and changes no account order; it only
shifts when each idle seat's window resets. Options:
[configuration](configuration.md#window-warm-up).

## Ordered provider routes

`routing.routes` holds an ordered list of enabled providers for one wire protocol:
`anthropic-messages` or `openai-responses`. A pool never translates between
those protocols. Each provider may optionally declare the client model names it
serves and the upstream name to send. Selecting that provider changes only the
JSON `model` value in place; all other request bytes stay untouched.

A pool pin keeps a conversation on its prior account while that account is
eligible. The pool may try eligible accounts within the selected provider, but
never silently changes provider: moving provider loses prompt-cache warmth and
can change model behavior or cost. Request and usage records report the
provider and model that actually served the request. If no provider in a pool
serves the requested model, the proxy returns `400` naming
`provider_pools.<wire>`; add a matching model map or select a direct provider
route intentionally.

For a Claude Code request that carries the Agent-smith companion's interactive
marker, the proxy returns only eligible configured alternatives when the selected
provider has a capacity block. It never changes the provider until the person
chooses one. The companion's **Wait** option may hold
the same request only for a known reset inside the configured hold window; a
longer wait returns the original block without sending upstream again. An
upstream block without a reset remains manual: it is not silently retried
or promoted later as though it recovered.

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

For a pool route, an ordinary caller receives the current provider's capacity
or error response instead of silently moving to another provider. A wrapped
Claude Code session may make that move only after the person chooses it. A
named unattended device with `allow_fallbacks: true` may continue
only to later configured providers after a block. A per-minute 429 always
remains on its current provider.

No branch may silently reach a third account.

## Configuration compatibility

`lb_strategy: "session"` remains the only accepted strategy name for API and
configuration compatibility. In W2 it does not create a five-hour sticky
session. `session_duration_ms` is likewise retained as a legacy configuration
field and does not affect account choice. Do not use either setting to infer
conversation affinity.

The compatibility strategy name remains unrelated to provider-pool sharing.
