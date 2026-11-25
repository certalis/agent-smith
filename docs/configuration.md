# agent-smith Configuration Guide

This guide covers all configuration options for agent-smith, including file-based configuration, environment variables, and runtime API updates.

`AGENT_SMITH_ENROLLMENT_ORIGIN` optionally enables the [stable link and private invitation flow](api-http.md#private-claude-seat-enrollment-opt-in).
It must be an exact HTTPS origin, with no path/trailing slash; HTTP is accepted
only for loopback tests. Invalid values fail startup. Unset disables enrollment.
This setting does not enable team routing or change account-pool limits.

## Table of Contents

- [Configuration Overview](#configuration-overview)
- [Configuration Precedence](#configuration-precedence)
- [Configuration File Format](#configuration-file-format)
- [Configuration Options](#configuration-options)
- [Client wrappers](#client-wrappers)
- [Environment Variables](#environment-variables)
- [Runtime Configuration API](#runtime-configuration-api)
- [Example Configurations](#example-configurations)
- [Configuration Validation](#configuration-validation)
- [Migration Guide](#migration-guide)

## Configuration Overview

agent-smith uses a flexible configuration system that supports:

- **File-based configuration**: JSON configuration file for persistent settings
- **Environment variables**: Override configuration for deployment flexibility
- **Runtime updates**: Modify certain settings via API without restart

Configuration is managed through the `@agent-smith/config` package, which provides automatic loading, validation, and change notifications.

## Configuration Precedence

Configuration values are resolved in the following order (highest to lowest priority):

1. **Environment variables** - Always take precedence when set
2. **Configuration file** - Values from `~/.config/agent-smith/agent-smith.json` (or custom path)
3. **Default values** - Built-in defaults when no other value is specified

### Special Cases

- **Load balancing strategy**: Environment variable `AGENT_SMITH_LB_STRATEGY` overrides file configuration
- **Runtime configuration**: Some values (like strategy) can be changed at runtime via API

## Configuration File Format

The configuration file is stored at:

- **Linux/macOS**: `~/.config/agent-smith/agent-smith.json` (or `$XDG_CONFIG_HOME/agent-smith/agent-smith.json`)
- **Windows**: `%LOCALAPPDATA%\agent-smith\agent-smith.json` (or `%APPDATA%\agent-smith\agent-smith.json`)
- **Custom path**: Set via `AGENT_SMITH_CONFIG_PATH` environment variable

### File Structure

```json
{
  "lb_strategy": "session",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "max_body_bytes": 67108864,
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "request_scoped_429_retry_delay_ms": 2000,
  "session_duration_ms": 18000000,
  "port": 8080,
  "providers": {
    "anthropic": {
      "enabled": true
    },
    "openai": {
      "enabled": true
    },
    "claude-code": {
      "enabled": false,
      "pool": {
        "enabled": false,
        "members": [],
        "distribution_enabled": true,
        "prefer_expiring_quota": false,
        "max_usage": 0.9,
        "weekly_max_usage": 0.95,
        "weekly_max_usage_by_email": {},
        "caller_weekly_max_usage": {},
        "quota_probe_seconds": 0,
        "window_warmup": {
          "enabled": false,
          "times": [
            "06:00"
          ],
          "time_zone": "Europe/Paris",
          "weekdays_only": true
        },
        "admission": {
          "cap": 5,
          "queue_limit": 25,
          "wait_ms": 30000
        },
        "block_when_all_full": true
      }
    },
    "codex": {
      "enabled": false
    }
  },
  "client": {
    "enabled": false,
    "base_url": "http://127.0.0.1:18181",
    "proxy_key_file": "~/.config/agent-smith/team-pool.key"
  },
  "alerts": {
    "slack_webhook_url": "",
    "slack_bot_token": "",
    "slack_channel": "",
    "email": "",
    "email_from": "",
    "resend_api_key": ""
  },
  "routing": {
    "routes": {},
    "api_key_accounts": "everyone",
    "callers": {},
    "hold_seconds": 0
  }
}
```

## Configuration Options

### Complete Options Table

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `lb_strategy` | string | `"session"` | Compatibility strategy name. W2 orders accounts by quota and priority; it does not create a sticky session. |
| `client_id` | string | `"9d1c250a-e61b-44d9-88ed-5944d1962f5e"` | OAuth client ID for authentication |
| `max_body_bytes` | number | `67108864` | Maximum request size the proxy buffers; `0` disables the cap |
| `retry_attempts` | number | `3` | Maximum number of retry attempts for failed requests |
| `retry_delay_ms` | number | `1000` | Initial delay in milliseconds between retry attempts |
| `retry_backoff` | number | `2` | Exponential backoff multiplier for retry delays |
| `request_scoped_429_retry_delay_ms` | number | `2000` | Delay before the one permitted retry after a request-scoped 429 |
| `session_duration_ms` | number | `18000000` (5 hours) | Legacy compatibility field; it does not affect W2 account selection. |
| `port` | number | `8080` | HTTP server port |
| `host` | string | `"127.0.0.1"` | Interface to bind; use `AGENT_SMITH_HOST` for deployment overrides |
| `trust_loopback` | boolean | `true` | Allow direct loopback requests without a key; set `false` behind a same-host reverse proxy that does not forward client-address headers |
| `providers.<name>.pool` | object | absent | Per-provider subscription pool membership and capacity policy; see below. |
| `alerts` | object | every channel off | Where seat alerts go; see [Alerts](#alerts). |
| `enrollment_emails` | string[] | `[]` | Addresses or exact-domain rules (`*@example.test`) the stable `/pool-enroll` link admits (lowercased, at most 200 entries). Domain rules do not include subdomains. Edit through `POST /api/enrollment-emails`, which applies live. |
| `providers` | object | see below | Enabled routes and their built-in protocol strategy. |
| `routing` | object | defaults | Ordered provider routes, API-key reach, caller fallback and hold policy. |
| `client` | object | absent | The endpoint and forwarding key for wrappers installed on this machine. It does not configure providers or change the server's pool. |

### Client wrappers

`client` is optional. `agent-smith client on|off|status` controls this machine's
shared-pool use. The launchers read it each time Claude Code or Codex starts:

- `enabled`: `false` by default. `client on` and `client off` persist this switch
  while preserving the other settings. First use installs or updates launchers;
  later switches need no reinstall or shell edit. Off delegates to the native
  clients without reading the forwarding key. Restart existing client sessions.
- `base_url`: the HTTP(S) origin of the one Agent Smith server this machine can
  reach. It has no path.
- `proxy_key_file`: an absolute path, or `~/` path, to an owner-only file
  containing the forwarding key. The key lets Claude Code and Codex send
  requests through the proxy but cannot change accounts or settings.
- `keep_claude_login`: `false` by default. Only literal `true` makes the Claude
  Code wrapper send the forwarding key as an `x-api-key` header through
  `ANTHROPIC_CUSTOM_HEADERS` instead of as `ANTHROPIC_API_KEY`. Claude Code then
  keeps its own claude.ai login active, so login-only features such as Claude in
  Chrome and claude.ai connectors stay on while requests still use the pool.
  Each request also carries that login's token to this Agent Smith server, which
  removes it before forwarding. Claude Code asks for a login when none is saved.
  Codex is unchanged.
- `pool_ssh_host`: absent by default. The SSH destination (`user@host` or a
  `~/.ssh/config` alias) of the standalone pool host, used only by
  `agent-smith menubar` to read the pool's status. It must start with a letter,
  digit or underscore and contain only letters, digits, `.`, `_`, `-` and one
  `@`; other values are ignored.

The agents service and a development caller use the same two values: an origin
and a forwarding key. On the agents service they are environment settings; on a
laptop the origin lives in the private local config and the key stays in its
own owner-only file, so generated wrappers can use it without embedding it.
Agent Smith attempts to tighten its config to `0600` when it reads it; the key
file must already be `0600`.

`client status` is read-only and prints readable text; `--raw` selects JSON.
Malformed or unreadable installed client settings stop the launcher rather than
silently spending from a personal login. `install-client` remains available for
explicit setup/removal, but is not required after toggles or origin changes.

This is not B2 tenancy. One forwarding key does not identify individual callers
or provide per-client fairness, so it is for the isolated B1 development path,
not a team-wide distribution mechanism.

For SSH v1, point `base_url` at the local side of the SSH forward, for example
`http://127.0.0.1:18181`. SSH is only the network path; it does not create a
second pool or change routing. See the [SSH walkthrough](../README.md#connect-an-authorized-development-caller-through-ssh).

### Providers

`anthropic` and `openai` are enabled by default for API-key accounts.
Subscription sign-ins, `claude-code` and `codex`, are disabled until the
operator enables them locally. This is deliberately an operator decision under
each provider's terms.

Each provider entry accepts `enabled`, its built-in `strategy`, an optional
`base_url`, and an optional `models` map. A named compatible endpoint can
reuse the Anthropic API strategy:

```json
{
  "providers": {
    "acme": {
      "enabled": true,
      "strategy": "anthropic-api",
      "base_url": "https://api.acme.example"
    },
    "claude-code": { "enabled": true }
  }
}
```

This enables `/v1/acme/*` and `/v1/claude-code/*`. A disabled provider keeps
saved accounts visible but cannot be selected. Subscription pool membership is
controlled by that provider’s `pool.members`; there is no provider
account-count setting.

`google-gemini-api` is a named, API-key-only provider strategy for the Gemini
Developer API. It serves the `anthropic-messages` wire: Agent Smith translates
the supported Anthropic Messages request and response at the selected provider
edge, while routing and account selection remain on the canonical wire. Give it
an explicit `models` map; the mapped value is the Gemini model name used in the
native endpoint URL. It currently supports text, system text, generation
settings, declared functions, function calls, and function results. Images,
documents, cached content, thinking, Anthropic beta features, provider-hosted
tools, metadata, context management, output configuration, service tier, and
stream options return a client error rather than being silently omitted.

### Provider pools and model maps

`routing.routes` creates one client route for an ordered list of providers that
speak the same client-facing protocol. The two wire names are
`anthropic-messages` and `openai-responses`; a provider on the other wire is
ignored. `google-gemini-api` is the explicit native adapter exception: it joins
the `anthropic-messages` pool and translates only after that provider has been
selected. `pool` is reserved and cannot be a provider name.

```json
{
  "providers": {
    "claude-code": {
      "enabled": true
    },
    "acme": {
      "enabled": true,
      "strategy": "anthropic-api",
      "base_url": "https://api.acme.example",
      "models": {
        "claude-sonnet-*": "acme-large"
      }
    }
  },
  "routing": {
    "routes": {
      "anthropic-messages": [
        "claude-code",
        "acme"
      ]
    }
  }
}
```

That configuration enables `/v1/pool/anthropic-messages/*`. Providers without
a `models` map receive the requested model name unchanged. A configured map is
an allowlist: its exact keys and trailing-`*` prefixes are the only client
model names that provider can serve. On a mapped provider, only the JSON
`model` value is patched in place; no request protocol is translated.

The pool starts with the first compatible provider. An ordinary request stays
there: a wrapped Claude Code user must choose another provider, or a named
unattended device must have the private ordered-fallback policy. A provider
move loses prompt-cache warmth and may change model behavior or cost. A
per-minute 429 never moves providers, and a direct `/v1/<provider>/*` route
never traverses the ordered route; the provider’s seat pool still applies. If no
route provider serves a model, the proxy returns `400`
naming `provider_pools.<wire>`; add a compatible provider/model map or use a
direct route intentionally.

### Qwen and Kimi through Model Studio

[`model-studio-compatible-providers.json`](../examples/config/model-studio-compatible-providers.json)
is a complete API-key example for Qwen and Model-Studio-hosted Kimi. It keeps
the two client protocols separate:

- Claude Code requests can use `qwen-claude` or `kimi-claude`; both use the
  Anthropic Messages wire.
- Codex requests can use `qwen-codex` or `kimi-codex`; both use the OpenAI
  Responses wire.

The example starts each pool with Qwen, then Kimi. Its public URLs target the
Beijing Model Studio region, so use a Beijing API key. For another region, use
that region's matching endpoint and API key together. Add a Model Studio
API-key account for each configured provider name. Using the same key under
more than one name selects different models; it does not create extra capacity.
A workspace endpoint such as
`https://<WorkspaceId>.<region>.maas.aliyuncs.com/apps/anthropic` also works as
`base_url`; the models available there depend on that workspace's region and
deployment scope.

The `kimi-*` names use Kimi models supplied through Model Studio. They are not
a direct Kimi Chat Completions API configuration, which Agent-smith does not
translate; a Kimi Code key goes direct, below.

### Kimi Code

[`kimi-code-providers.json`](../examples/config/kimi-code-providers.json)
sends Claude Code to Kimi Code's own Anthropic Messages endpoint,
`https://api.kimi.ai/coding`, with the `kimi-code-anthropic-api` strategy. It
maps every model Claude Code requests to `k3.1-pro`, the model Kimi's Claude
Code guide sets, because Kimi Code rejects Claude model names. Add one API-key
account with a key from the Kimi Code console; it needs a Kimi plan that
includes Kimi Code, and spends that plan's quota and rolling five-hour limit.
The strategy reads every Kimi 429 as a full provider: an ordered-fallback
caller walks on to the next provider and an interactive one gets the chooser,
instead of the request failing. Place it in the pool where it should rank,
for example right after `claude-code`. With restricted API-key reach, a person picks it in
the Claude Code chooser like any other API-key provider.

Codex is not covered: Kimi's Codex guide gives Codex its own model catalog, and
through a pool Codex sends tools for the GPT model it asked for, which Kimi
rejects (`tool type "tool_search" is not supported`).

If you have separately enabled and are authorized to use the Claude Code or
Codex subscription provider, put it first in its matching pool yourself. The
example deliberately does not enable subscription sign-ins. Restart
Agent-smith after changing providers or pools.

When Claude Code is started through `agent-smith install-client`, its wrapper
loads the Agent-smith companion. For an interactive Claude-compatible pool,
Agent-smith never silently changes provider. If the current provider blocks a
turn, Claude Code shows the eligible replacements in the configured pool order,
then **Wait**. Choosing one resends the same turn and context with only the
mapped model changed; the chosen provider stays pinned for that conversation.
Claude Code background requests, including title generation, reuse that choice
without opening another chooser.
The companion status row under Claude's prompt reports the provider that
actually answered and its mapped model, not the requested model. This is a
companion row, not a replacement for Claude Code's native status line.
Claude Code adds its warning glyph and the companion's name to that row.

The block text distinguishes five-hour and weekly pool limits, request rate,
token allocation, traffic burst, temporary capacity, and an unknown upstream
limit. It shows a retry time only when the upstream supplied one. **Wait**
holds the request only when that time falls inside the configured
`routing.hold_seconds`; outside that window it returns the same truthful
block without a duplicate upstream retry. An unknown limit never gets a
made-up countdown or a duplicate retry. A higher-ranked provider is offered
once only after a known retry time or local pool availability says it may be
tried, and only after the next completed main turn. Declining keeps the current
provider quiet for the rest of the conversation. Run
`/agent-smith-provider` in Claude Code to reopen the full chooser on the next
turn. Message-thread continuations never switch providers.

Unwrapped or unattended clients stay on their current provider. A capacity block
returns `429`, with `Retry-After` only when the provider supplied a retry time;
they never silently move to another configured provider. The sole exception is
a registered device with private `routing.callers.<device>.allow_fallbacks`
set to `true`: it continues forward through the configured pool order
after a block. This is server policy, not a request header a client can opt into.
With `routing.api_key_accounts: "chooser_or_fallback"`, API-key accounts serve
that device’s walk and chooser-capable requests;
that device keeps the chooser too when it runs a wrapped session.
Switching from a Claude Code chat to Codex means starting a new Codex chat and
handing off the needed context yourself: the two clients use different request
formats and Agent-smith does not convert chat history between them.

### Provider pools

A `providers.<name>.pool` block supplies membership and capacity settings for
that provider. Its presence enables sharing by default; `enabled: false` keeps
its settings while sharing is off. Without a pool block, sharing is off. A
provider’s `enabled` flag separately controls whether that provider is available.
Unknown or invalid fields in a management update are rejected.

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` when the block exists | Enable sharing for this provider. |
| `members` | `[]` | Exact OAuth seat UUIDs allowed in this provider’s pool. |
| `distribution_enabled` | `true` | Disabling drains existing conversation pins and stops placing new ones. |
| `prefer_expiring_quota` | `false` | Prefer fresh quota close to reset for new pins; hard caps and existing pins remain. |
| `max_usage` | `0.9` | Non-weekly hard utilization ceiling, greater than zero and at most `0.9`. |
| `weekly_max_usage` | `0.95` | Weekly hard ceiling, greater than zero and at most `0.95`. |
| `weekly_max_usage_by_email` | `{}` | Private per-enrolled-email weekly ceilings, up to `1`. |
| `caller_weekly_max_usage` | `{}` | Private registered-device weekly ceilings; an eligibility rule, not a usage meter. |
| `admission.cap` | `5` | Per-account active-request limit. |
| `admission.queue_limit` | `25` | Per-account FIFO queue limit. |
| `admission.wait_ms` | `30000` | Maximum admission wait. |
| `quota_probe_seconds` | `0` | Opt-in zero-spend OAuth quota refresh interval. |
| `window_warmup` | off | Optional daily start of idle seats’ five-hour windows. |
| `block_when_all_full` | `true` | When false, allow one real revalidation per minute when full; it may spend extra usage. |

Email overrides use private enrollment contacts and do not add accounts or
resume paused accounts. `GET /api/config/providers/<name>/pool` omits the two
private maps. POST preserves omitted top-level fields; supplying `admission` replaces that
nested object. Use an explicit empty object to clear a private map. The corresponding `DELETE` removes the
pool block. Changes apply live.

### Router settings

`routing.routes` maps a wire to an ordered list of provider names.
`routing.api_key_accounts` is `everyone` by default or
`chooser_or_fallback` to limit key-account reach to a chooser or an ordered
caller. `routing.callers.<device>.allow_fallbacks: true` lets a registered
unattended device advance through the route after a capacity block. The
private caller map is omitted from API responses. `routing.hold_seconds`
sets the maximum wait for a known reset. Ordered fallback works even when no
provider has a subscription pool. For example:

```json
{
  "providers": {
    "claude-code": {
      "enabled": true,
      "pool": { "members": ["seat-uuid"], "max_usage": 0.8 }
    },
    "anthropic": { "enabled": true }
  },
  "routing": {
    "routes": { "anthropic-messages": ["claude-code", "anthropic"] },
    "api_key_accounts": "chooser_or_fallback",
    "callers": { "build-box": { "allow_fallbacks": true } },
    "hold_seconds": 30
  }
}
```

### Migration and rollback

On first start, Agent Smith automatically rewrites supported legacy
`team_routing`, `provider_pools` and root `block_when_all_full` settings. It
atomically replaces the config and keeps the original as
`<config-path>.backup`, mode `0600`; the startup log names both files. For a
symlink, the backup sits beside the resolved target, and the link stays intact.
Later starts leave both files unchanged. Backups are never overwritten. If the
backup already contains the same private file, it is reused. If it differs, a
new backup is saved as `<config-path>.backup-<UTC timestamp>`; the log or manual
command names the backup used. A number is added if that name cannot be reused.

The migration refuses with a reason and `agent-smith config rewrite` if it
cannot safely proceed, for example if the config is read-only, has unknown
legacy settings, or mixes old and new routing. Do not edit the file while a
rewrite is in progress.

The manual command remains available for an in-place rewrite:

```bash
agent-smith config rewrite
```

For a staged server switch, write a separate file instead:

```bash
agent-smith config rewrite old-config.json new-config.json
```

The command reads and writes JSON only, does not access the database or network,
and refuses to overwrite an existing output. It copies the old global pool
policy conservatively to all configured and built-in providers because it
cannot inspect account inventory; review the result and remove unnecessary
pools. Disabled legacy sharing becomes a disabled pool when settings must be
retained. Per the migration rule, ordered callers are carried over only when
legacy team routing was enabled; review dormant caller policy before enabling
sharing later.

To roll back an automatically migrated config, restore the backup to the config
path and run the previous Agent Smith version. For the standalone pool, pause
auto-deploy and stage a separate rewritten file before merging the switch. Test
a copy of the database only against a fake upstream, with probes and warm-up
disabled; real refreshes can rotate production tokens. Deploy with
`AGENT_SMITH_CONFIG_PATH` set to the new file, check the seats and approved
canaries, then resume auto-deploy. Roll back by pointing the path to the old
file and redeploying the previous commit. Coordinate the operator-script
update as described in the split plan before the switch.

The server does not watch a hand-edited config file; restart it after editing.
Management API updates apply live, and client launchers reread their config on
each launch.

#### Window warm-up

`window_warmup` sends requests nobody typed, so it ships off. Turned on, at each
configured local time it sends one minimal billed message on each allowlisted,
unpaused seat's own credentials, so that seat's five-hour window starts then
and resets five hours later, inside the working day. Like the quota probe, it
only reaches seats with no custom upstream. A seat whose five-hour window
already runs, or that any window holds at its hard cap (`max_usage`, or the
weekly ceiling), is skipped. A refused request is logged and not retried; the
reply's quota headers become the seat's reading, booked as proxy activity
rather than outside spend. A restart misses a time that passed while it was
down. `GET /api/status` reports the next run as `nextWindowWarmupAt` (epoch
milliseconds, `null` while off).

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Turns the warm-up on; that provider’s pool must be enabled as well. |
| `times` | `["06:00"]` | Local `HH:MM` times, 24-hour. |
| `time_zone` | `"Europe/Paris"` | IANA time zone the times are read in, daylight saving included. |
| `weekdays_only` | `true` | Skips Saturday and Sunday. |
| `model` | the provider's cheapest | Model of the warm-up message; Claude Code uses `claude-haiku-5-5`. |

One unknown or invalid field rejects the whole `window_warmup` object through
the API, and drops it (warm-up off) from a hand-edited file. A pool `POST`
that omits `window_warmup` preserves the existing schedule.

### Alerts

`alerts` sends a warning when a seat is past its plan limit and a response it
served was billed to extra usage (one alert per such response, when it ends),
and when every account of a provider or pool is full (one alert until the
soonest reset passes). Each channel is on once its values are filled; an empty
or missing value keeps it off. Alerts name the seat and its provider, never a
token, an account id or prompt content.

| Field | Description |
|-------|-------------|
| `slack_webhook_url` | A Slack incoming-webhook URL (`https://` only) for the channel to post in. |
| `slack_bot_token` | A Slack bot token with `chat:write`, for a bot already in the channel: posts through `chat.postMessage`. Needs `slack_channel`. |
| `slack_channel` | The channel id the bot posts in. Slack bot alerts stay off without it. |
| `email` | The address that receives alert emails. |
| `email_from` | The sender, on a domain verified in Resend. Email stays off without it. |
| `resend_api_key` | The Resend API key used to send the email. Email stays off without it. |

The webhook URL, the bot token and the Resend key are credentials: keep the config file
private. Every write agent-smith makes lands it `0600`, and a file you create
yourself should be `chmod 600`. A failed send is logged with its channel only,
and never retried.

### Exposure security

The server binds to `127.0.0.1` by default. To serve requests outside that interface, set `AGENT_SMITH_HOST` and a `AGENT_SMITH_PROXY_KEY`; external callers must send that key in `x-api-key`. A request carrying `Forwarded`, `X-Forwarded-For`, or `X-Real-IP` is never treated as a direct loopback request, so the key is required even when a same-host reverse proxy connects from `127.0.0.1`.

Set `AGENT_SMITH_ADMIN_KEY` separately for management writes under `/api`. Every management write requires this configured matching key; without it, writes are refused, including on direct loopback. The proxy key can forward provider requests but cannot make management changes. Keep both keys in the process environment, never in the JSON configuration file. Browser-originated management requests are rejected unless they are same-origin. In the dashboard, enter the admin key through **Unlock management**; it is kept only for that browser tab and is never embedded in the dashboard build.

### Local client routing

The interactive **Local pool** screen can explicitly enable routing for the
locally installed `claude` and `codex` clients. It writes wrappers under the
agent-smith config directory and one marked PATH block in the active shell profile;
the original client binaries and their configuration are not modified. The
wrappers route to the loopback proxy and work while the TUI is running.
The generated Claude wrapper also copies and loads Agent-smith's own companion
plugin under its private wrapper directory. It does not modify Claude Code's
global plugin list, status line, Zed, or any other editor.
When a matching `routing.routes` entry is configured, the Claude and Codex
wrappers use its protocol route; without one, they retain their direct provider
routes.

Enable or remove this integration from the Local pool screen with `e`. Open a
new terminal after enabling it. The status in the screen is the source of truth;
do not copy proxy credentials into shell profiles for local routing.

For a shared Agent Smith server, use the [`client` configuration](#client-wrappers)
and `agent-smith client on` instead. Its wrappers use the configured origin
and forwarding key, whether the origin is directly reachable or the local side
of an SSH tunnel.

The Codex wrapper passes its Agent-smith provider settings when it starts
Codex; it does not write them into Codex's configuration. Put a permanent
Codex provider in `~/.codex/config.toml`, not a repository
`.codex/config.toml`. Project configuration cannot redirect provider traffic.

### Load Balancing Strategy

`session` is the sole accepted configuration value for compatibility. It no
longer creates five-hour account affinity: W2 chooses eligible accounts by
quota and priority, while only explicit message-thread continuations preserve
an account.

| Strategy | Description | Use Case |
|----------|-------------|----------|
| `session` | Compatibility name for quota- and priority-ordered routing | Only accepted value |

### Logging Configuration (Environment Only)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `AGENT_SMITH_LOG_LEVEL` | string | `"INFO"` | Logging level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `AGENT_SMITH_LOG_FORMAT` | string | `"pretty"` | Log format: `"pretty"` or `"json"` |
| `AGENT_SMITH_DEBUG` | string | - | Set to `"1"` to enable debug mode with console output |

## Environment Variables

### Configuration Mapping

| Environment Variable | Config Field | Type | Example |
|---------------------|--------------|------|---------|
| `AGENT_SMITH_LB_STRATEGY` | `lb_strategy` | string | `AGENT_SMITH_LB_STRATEGY=session` |
| `AGENT_SMITH_CLIENT_ID` | `client_id` | string | `AGENT_SMITH_CLIENT_ID=your-client-id` |
| `AGENT_SMITH_MAX_BODY_BYTES` | `max_body_bytes` | number | `AGENT_SMITH_MAX_BODY_BYTES=67108864` |
| `AGENT_SMITH_RETRY_ATTEMPTS` | `retry_attempts` | number | `AGENT_SMITH_RETRY_ATTEMPTS=5` |
| `AGENT_SMITH_RETRY_DELAY_MS` | `retry_delay_ms` | number | `AGENT_SMITH_RETRY_DELAY_MS=2000` |
| `AGENT_SMITH_RETRY_BACKOFF` | `retry_backoff` | number | `AGENT_SMITH_RETRY_BACKOFF=1.5` |
| `AGENT_SMITH_REQUEST_SCOPED_429_RETRY_DELAY_MS` | `request_scoped_429_retry_delay_ms` | number | `AGENT_SMITH_REQUEST_SCOPED_429_RETRY_DELAY_MS=2000` |
| `AGENT_SMITH_SESSION_DURATION_MS` | `session_duration_ms` | number | `AGENT_SMITH_SESSION_DURATION_MS=3600000` |
| `PORT` | `port` | number | `PORT=3000` |
| `AGENT_SMITH_HOST` | `host` | string | `AGENT_SMITH_HOST=127.0.0.1` |
| `AGENT_SMITH_TRUST_LOOPBACK` | `trust_loopback` | boolean | `AGENT_SMITH_TRUST_LOOPBACK=false` |
| `AGENT_SMITH_PROXY_KEY` | - (not persisted) | string | `AGENT_SMITH_PROXY_KEY=proxy-secret` |
| `AGENT_SMITH_CLIENT_KEYS_FILE` | - (disabled) | absolute path | Owner-only JSON mapping device names to SHA-256 key digests; reloaded each request |
| `AGENT_SMITH_ADMIN_KEY` | - (not persisted) | string | `AGENT_SMITH_ADMIN_KEY=admin-secret` |
| `AGENT_SMITH_DATA_RETENTION_DAYS` | `data_retention_days` | number | `AGENT_SMITH_DATA_RETENTION_DAYS=7` (payloads, 0–365; 0 stores none) |
| `AGENT_SMITH_REQUEST_RETENTION_DAYS` | `request_retention_days` | number | `AGENT_SMITH_REQUEST_RETENTION_DAYS=365` (metadata) |
| `AGENT_SMITH_CONFIG_PATH` | - | string | `AGENT_SMITH_CONFIG_PATH=/etc/agent-smith.json` |

### Additional Environment Variables

These environment variables are not stored in the configuration file and must be set via environment:

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `AGENT_SMITH_LOG_LEVEL` | Set logging verbosity (DEBUG, INFO, WARN, ERROR) | `INFO` | `AGENT_SMITH_LOG_LEVEL=DEBUG` |
| `AGENT_SMITH_LOG_FORMAT` | Set log output format (pretty, json) | `pretty` | `AGENT_SMITH_LOG_FORMAT=json` |
| `AGENT_SMITH_DEBUG` | Enable debug mode with console output | - | `AGENT_SMITH_DEBUG=1` |
| `AGENT_SMITH_DB_PATH` | Custom database file path | Platform-specific | `AGENT_SMITH_DB_PATH=/var/lib/agent-smith/db.sqlite` |
| `AGENT_SMITH_PRICING_REFRESH_HOURS` | Hours between pricing data refreshes | `24` | `AGENT_SMITH_PRICING_REFRESH_HOURS=12` |
| `AGENT_SMITH_STREAM_USAGE_BUFFER_KB` | Stream usage buffer size in KB | `64` | `AGENT_SMITH_STREAM_USAGE_BUFFER_KB=128` |
| `AGENT_SMITH_STREAM_TIMEOUT_MS` | Stream processing timeout in milliseconds | `60000` (1 minute) | `AGENT_SMITH_STREAM_TIMEOUT_MS=120000` |

## Runtime Configuration API

Some configuration values can be updated at runtime through the HTTP API without restarting the server.

### Available Endpoints

#### Get Current Configuration
```http
GET /api/config
```

Response:
```json
{
  "lb_strategy": "session",
  "port": 8080,
  "sessionDurationMs": 18000000
}
```

Note: The API response uses camelCase (`sessionDurationMs`) while the configuration file uses snake_case (`session_duration_ms`).

#### Get Current Strategy
```http
GET /api/config/strategy
```

Response:
```json
{
  "strategy": "session"
}
```

#### Update Strategy
```http
POST /api/config/strategy
Content-Type: application/json

{
  "strategy": "session"
}
```

Response:
```json
{
  "success": true,
  "strategy": "session"
}
```

#### Get Available Strategies
```http
GET /api/strategies
```

Response:
```json
["session"]
```

**Note:** `"session"` remains the only accepted compatibility name. It does not create a five-hour sticky session; W2 routing uses quota and priority.

#### Read or update pool and Router settings

```http
GET /api/config/providers/claude-code/pool
POST /api/config/providers/claude-code/pool
DELETE /api/config/providers/claude-code/pool
GET /api/config/routing
POST /api/config/routing
x-api-key: <admin key>
Content-Type: application/json
```

Management writes require `AGENT_SMITH_ADMIN_KEY`. POST accepts the snake_case
file fields above, preserves omitted fields, and applies live. Pool GET and
POST responses expose public values in camelCase; Router responses expose
`routes`, `apiKeyAccounts` and `holdSeconds`. Private email ceilings, caller
ceilings and Router callers are write-only. Their keys must match the protected
device-key registry; a request header alone cannot grant an override. A
scheduler can read its own reachable capacity via
`GET /api/pool-status?pool=<wire>` and its device key.

### Runtime Update Behavior

- Strategy changes take effect immediately for new requests
- The compatibility name does not retain fleet-wide session affinity
- Configuration file is automatically updated when changed via API
- Change events are emitted for monitoring and logging

## Example Configurations

### High Throughput Setup

Optimized for maximum request throughput with minimal overhead:

```json
{
  "retry_attempts": 2,
  "retry_delay_ms": 500,
  "retry_backoff": 1.5,
  "port": 8080
}
```

Environment variables:
```bash
export AGENT_SMITH_RETRY_ATTEMPTS=2
export AGENT_SMITH_RETRY_DELAY_MS=500
export AGENT_SMITH_LOG_LEVEL=WARN  # Reduce logging overhead
```

### Quota-Aware Pool Setup

Use explicit priority and quota state to choose eligible accounts. Message-thread
continuations preserve their account where possible; ordinary requests do not
need a fixed session duration.

```json
{
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "port": 8080
}
```

Environment variables:
```bash
export AGENT_SMITH_RETRY_ATTEMPTS=3
export AGENT_SMITH_LOG_LEVEL=INFO
```

### Development Setup

Configuration for local development and debugging:

```json
{
  "retry_attempts": 5,
  "retry_delay_ms": 2000,
  "retry_backoff": 2,
  "port": 3000
}
```

Environment variables:
```bash
export PORT=3000
export AGENT_SMITH_LOG_LEVEL=DEBUG
export AGENT_SMITH_LOG_FORMAT=pretty
export AGENT_SMITH_DEBUG=1
export AGENT_SMITH_RETRY_ATTEMPTS=5
```

### Production Setup

Recommended configuration for production deployments:

```json
{
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "port": 8080
}
```

Environment variables:
```bash
export AGENT_SMITH_LOG_LEVEL=INFO
export AGENT_SMITH_LOG_FORMAT=json
```

## Configuration Validation

### Automatic Validation

agent-smith performs validation on:

1. **Strategy names**: `session` is retained only as a validated compatibility name
2. **Numeric values**: Parsed and validated as integers/floats
3. **Port ranges**: Should be valid port numbers (1-65535)
4. **File permissions**: Config directory is created with appropriate permissions

### Validation Errors

Invalid configurations result in:

- **Strategy errors**: Throws error when setting via API, falls back to default strategy when loading
- **Parse errors**: Logged to console, uses default values
- **File errors**: Creates new config file with defaults
- **Invalid numeric values**: Falls back to default values

### Best Practices

1. **Test configuration changes**: Use the API to test strategy changes before updating files
2. **Monitor logs**: Check logs after configuration updates for validation errors
3. **Use environment variables**: For deployment-specific settings that shouldn't be committed
4. **Backup configurations**: Keep backups before major changes

## Migration Guide

### From Environment-Only Configuration

If migrating from environment variables to file-based configuration:

1. Create the configuration file:
   ```bash
   mkdir -p ~/.config/agent-smith
   ```

2. Export current configuration:
   ```bash
   curl http://localhost:8080/api/config > ~/.config/agent-smith/agent-smith.json
   ```

3. Edit and format the file:
   ```bash
   jq '.' ~/.config/agent-smith/agent-smith.json > temp.json && mv temp.json ~/.config/agent-smith/agent-smith.json
   ```

### From Older Versions

#### Pre-1.0 to Current

1. **Configuration location**: Move from `~/.agent-smith/config.json` to platform-specific paths
2. **Field naming**: Follow [Migration and rollback](#migration-and-rollback) for legacy routing fields
3. **Strategy names**: Only `"session"` strategy is available (must be lowercase)

### Configuration Backup

Keep a private copy of the configuration before upgrades. Automatic migration
and the in-place `agent-smith config rewrite` keep `<config-path>.backup` or,
if that backup differs, a new timestamped backup beside it.

### Rollback Procedure

If issues occur after configuration changes:

1. **Via API**: Revert strategy changes using the runtime API
2. **File restoration**: Restore the backup and run the previous Agent Smith version
3. **Environment override**: Use environment variables to override problematic settings

## Troubleshooting

### Common Issues

1. **Configuration not loading**:
   - Check file permissions: `ls -la ~/.config/agent-smith/`
   - Verify JSON syntax: `jq '.' ~/.config/agent-smith/agent-smith.json`
   - Check logs for parse errors

2. **Environment variables not working**:
   - Ensure variables are exported: `export VAR=value`
   - Check variable names match exactly (case-sensitive)
   - Verify no typos in variable names

3. **Runtime updates not persisting**:
   - Check file write permissions
   - Ensure configuration directory exists
   - Look for save errors in logs

### Debug Mode

Enable comprehensive debugging:

```bash
export AGENT_SMITH_DEBUG=1
export AGENT_SMITH_LOG_LEVEL=DEBUG
export AGENT_SMITH_LOG_FORMAT=json  # For structured logging
```

This provides detailed configuration loading information and operation logs.

#### Get Retention
```http
GET /api/config/retention
```

Response:
```json
{ "payloadDays": 7, "requestDays": 365 }
```

Note: Payload retention applies to the request metadata payloads in `request_payloads` (headers, trace fields, timings, token curve; never bodies). `0` stores none: the Requests page then shows live traffic only and has no stored conversations to open, while analytics keep working from the `requests` table. Request metadata retention controls how long rows in the `requests` table are kept (affects analytics beyond the window). Expired rows are deleted at startup and then every hour.

#### Set Retention
```http
POST /api/config/retention
Content-Type: application/json

{ "payloadDays": 14, "requestDays": 180 }
```

Response: `204 No Content`

#### Manual Cleanup
```http
POST /api/maintenance/cleanup
```

Response:
```json
{ "removedRequests": 0, "removedPayloads": 123, "cutoffIso": "2025-08-20T12:34:56.000Z" }
```
