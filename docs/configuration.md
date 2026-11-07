# ccflare Configuration Guide

This guide covers all configuration options for ccflare, including file-based configuration, environment variables, and runtime API updates.

`CF_ENROLLMENT_ORIGIN` optionally enables the [stable link and private invitation flow](api-http.md#private-claude-seat-enrollment-opt-in).
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

ccflare uses a flexible configuration system that supports:

- **File-based configuration**: JSON configuration file for persistent settings
- **Environment variables**: Override configuration for deployment flexibility
- **Runtime updates**: Modify certain settings via API without restart

Configuration is managed through the `@ccflare/config` package, which provides automatic loading, validation, and change notifications.

## Configuration Precedence

Configuration values are resolved in the following order (highest to lowest priority):

1. **Environment variables** - Always take precedence when set
2. **Configuration file** - Values from `~/.config/ccflare/ccflare.json` (or custom path)
3. **Default values** - Built-in defaults when no other value is specified

### Special Cases

- **Load balancing strategy**: Environment variable `LB_STRATEGY` overrides file configuration
- **Runtime configuration**: Some values (like strategy) can be changed at runtime via API

## Configuration File Format

The configuration file is stored at:

- **Linux/macOS**: `~/.config/ccflare/ccflare.json` (or `$XDG_CONFIG_HOME/ccflare/ccflare.json`)
- **Windows**: `%LOCALAPPDATA%\ccflare\ccflare.json` (or `%APPDATA%\ccflare\ccflare.json`)
- **Custom path**: Set via `ccflare_CONFIG_PATH` environment variable

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
    "anthropic": { "enabled": true },
    "openai": { "enabled": true },
    "claude-code": { "enabled": false },
    "codex": { "enabled": false }
  },
  "client": {
    "base_url": "http://10.76.0.1:8080",
    "proxy_key_file": "~/.config/ccflare/team-pool.key"
  },
  "team_routing": {
    "enabled": false,
    "distribution_enabled": true,
    "allowlisted_account_uuids": [],
    "max_usage": 0.9,
    "admission_cap": 5,
    "admission_queue_limit": 25,
    "admission_wait_ms": 30000,
    "hold_seconds": 0,
    "quota_probe_seconds": 0
  },
  "block_when_all_full": true,
  "alerts": {
    "slack_webhook_url": "",
    "slack_bot_token": "",
    "slack_channel": "",
    "email": "",
    "email_from": "",
    "resend_api_key": ""
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
| `host` | string | `"127.0.0.1"` | Interface to bind; use `CF_HOST` for a single deployment override |
| `trust_loopback` | boolean | `true` | Allow direct loopback requests without a key; set `false` behind a same-host reverse proxy that does not forward client-address headers |
| `team_routing` | object | disabled | Opt-in pooled-seat routing; see below. |
| `block_when_all_full` | boolean | `true` | When every account is full, refuse every request with a 429 until the soonest reset. `false` lets one request a minute through to revalidate, and that request may spend extra usage. |
| `alerts` | object | every channel off | Where seat alerts go; see [Alerts](#alerts). |
| `enrollment_emails` | string[] | `[]` | Emails the stable `/pool-enroll` link admits (lowercased, at most 200). Edit it through `POST /api/enrollment-emails`, which applies live. |
| `providers` | object | see below | Enabled routes and their built-in protocol strategy. |
| `provider_pools` | object | none | Ordered provider fallback routes, keyed by wire protocol. |
| `client` | object | absent | The endpoint and forwarding key for wrappers installed on this machine. It does not configure providers or change the server's pool. |

### Client wrappers

`client` is optional and is only read by `agent-smith install-client`. It has
two fields:

- `base_url`: the HTTP(S) origin of the one Agent-smith server this machine can
  reach. It has no path.
- `proxy_key_file`: an absolute path, or `~/` path, to an owner-only file
  containing the forwarding key. The key lets Claude Code and Codex send
  requests through the proxy but cannot change accounts or settings.

The agents service and a development caller use the same two values: an origin
and a forwarding key. On the agents service they are environment settings; on a
laptop the origin lives in the private local config and the key stays in its
own owner-only file, so generated wrappers can use it without embedding it.
Agent-smith attempts to tighten its config to `0600` when it reads it; the key
file must already be `0600`.

This is not B2 tenancy. One forwarding key does not identify individual callers
or provide per-client fairness, so it is for the isolated B1 development path,
not a team-wide distribution mechanism.

For a private network, point `base_url` at the server's WireGuard address, for
example `http://10.76.0.1:8080`. This is only the network path; it does not
create a second pool or change routing. See the
[private-network deployment guide](private-network.md). An SSH-local origin is
still possible for one-off development access, but is not the shared-pool
deployment shape.

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
controlled by `team_routing.allowlisted_account_uuids`; there is no provider
account-count setting.

### Provider pools and model maps

`provider_pools` creates one client route for an ordered list of providers that
speak the same protocol. The two wire names are `anthropic-messages` and
`openai-responses`; a provider on the other wire is ignored rather than being
translated. `pool` is reserved and cannot be a provider name.

```json
{
  "providers": {
    "claude-code": { "enabled": true },
    "acme": {
      "enabled": true,
      "strategy": "anthropic-api",
      "base_url": "https://api.acme.example",
      "models": { "claude-sonnet-*": "acme-large" }
    }
  },
  "provider_pools": {
    "anthropic-messages": ["claude-code", "acme"]
  }
}
```

That configuration enables `/v1/pool/anthropic-messages/*`. Providers without
a `models` map receive the requested model name unchanged. A configured map is
an allowlist: its exact keys and trailing-`*` prefixes are the only client
model names that provider can serve. On a mapped provider, only the JSON
`model` value is patched in place; no request protocol is translated.

The pool tries the first compatible provider, then at most one next provider
when the first has no eligible account or has no eligible sibling for a
pre-output 5xx/529 failure. A provider move loses prompt-cache warmth and may
change model behavior or cost. A per-minute 429 never moves providers, and a
direct `/v1/<provider>/*` route never uses a pool. If no pool provider serves a
model, the proxy returns `400` naming `provider_pools.<wire>`; add a compatible
provider/model map or use a direct route intentionally.

### Team routing

`team_routing` is a single validated policy object. Unknown or invalid fields
are rejected when changed through the API; `max_usage` must be greater than
zero and no more than `0.9`.

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Enables pooled-seat routing; only UUIDs on the allowlist are eligible. |
| `distribution_enabled` | `true` | Disabling it drains existing conversation pins and stops placing new ones. |
| `allowlisted_account_uuids` | `[]` | Exact Claude Code OAuth seat UUIDs allowed in the pool. |
| `max_usage` | `0.9` | Hard 5-hour/weekly utilization ceiling for pooled seats. |
| `admission_cap` | `5` | Per-account active-request limit. |
| `admission_queue_limit` | `25` | Per-account FIFO queue limit. |
| `admission_wait_ms` | `30000` | Maximum admission wait. |
| `hold_seconds` | `0` | Wait only this long for a known quota reset; `0` returns 429 immediately. |
| `quota_probe_seconds` | `0` | Opt-in interval for a zero-spend OAuth quota refresh; `0` disables it. |

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

The server binds to `127.0.0.1` by default. To serve requests outside that interface, set `CF_HOST` and a `CF_PROXY_KEY`; external callers must send that key in `x-api-key`. For a private server that needs both loopback and a WireGuard address, set `CF_BIND_HOSTS` to the comma-separated addresses instead. Multiple listeners require Linux. A request carrying `Forwarded`, `X-Forwarded-For`, or `X-Real-IP` is never treated as a direct loopback request, so the key is required even when a same-host reverse proxy connects from `127.0.0.1`.

Set `CF_ADMIN_KEY` separately for management writes under `/api`. Every management write requires this configured matching key; without it, writes are refused, including on direct loopback. The proxy key can forward provider requests but cannot make management changes. Keep both keys in the process environment, never in the JSON configuration file. Browser-originated management requests are rejected unless they are same-origin. In the dashboard, enter the admin key through **Unlock management**; it is kept only for that browser tab and is never embedded in the dashboard build.

### Local client routing

The interactive **Local pool** screen can explicitly enable routing for the
locally installed `claude` and `codex` clients. It writes wrappers under the
ccflare config directory and one marked PATH block in the active shell profile;
the original client binaries and their configuration are not modified. The
wrappers route to the loopback proxy and work while the TUI is running.
When a matching `provider_pools` entry is configured, the Claude and Codex
wrappers use its protocol route; without one, they retain their direct provider
routes.

Enable or remove this integration from the Local pool screen with `e`. Open a
new terminal after enabling it. The status in the screen is the source of truth;
do not copy proxy credentials into shell profiles for local routing.

For a shared Agent-smith server, use the [`client` configuration](#client-wrappers)
and `agent-smith install-client` instead. Its wrappers use the configured origin
and forwarding key, including a private WireGuard origin.

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
| `LOG_LEVEL` | string | `"INFO"` | Logging level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `LOG_FORMAT` | string | `"pretty"` | Log format: `"pretty"` or `"json"` |
| `ccflare_DEBUG` | string | - | Set to `"1"` to enable debug mode with console output |

## Environment Variables

### Configuration Mapping

| Environment Variable | Config Field | Type | Example |
|---------------------|--------------|------|---------|
| `LB_STRATEGY` | `lb_strategy` | string | `LB_STRATEGY=session` |
| `CLIENT_ID` | `client_id` | string | `CLIENT_ID=your-client-id` |
| `MAX_BODY_BYTES` | `max_body_bytes` | number | `MAX_BODY_BYTES=67108864` |
| `RETRY_ATTEMPTS` | `retry_attempts` | number | `RETRY_ATTEMPTS=5` |
| `RETRY_DELAY_MS` | `retry_delay_ms` | number | `RETRY_DELAY_MS=2000` |
| `RETRY_BACKOFF` | `retry_backoff` | number | `RETRY_BACKOFF=1.5` |
| `REQUEST_SCOPED_429_RETRY_DELAY_MS` | `request_scoped_429_retry_delay_ms` | number | `REQUEST_SCOPED_429_RETRY_DELAY_MS=2000` |
| `SESSION_DURATION_MS` | `session_duration_ms` | number | `SESSION_DURATION_MS=3600000` |
| `PORT` | `port` | number | `PORT=3000` |
| `CF_HOST` | `host` | string | `CF_HOST=127.0.0.1` |
| `CF_BIND_HOSTS` | - (not persisted) | comma-separated strings | `CF_BIND_HOSTS=127.0.0.1,10.76.0.1` |
| `CF_TRUST_LOOPBACK` | `trust_loopback` | boolean | `CF_TRUST_LOOPBACK=false` |
| `CF_PROXY_KEY` | - (not persisted) | string | `CF_PROXY_KEY=proxy-secret` |
| `CF_ADMIN_KEY` | - (not persisted) | string | `CF_ADMIN_KEY=admin-secret` |
| `DATA_RETENTION_DAYS` | `data_retention_days` | number | `DATA_RETENTION_DAYS=7` (payloads) |
| `REQUEST_RETENTION_DAYS` | `request_retention_days` | number | `REQUEST_RETENTION_DAYS=365` (metadata) |
| `ccflare_CONFIG_PATH` | - | string | `ccflare_CONFIG_PATH=/etc/ccflare.json` |

### Additional Environment Variables

These environment variables are not stored in the configuration file and must be set via environment:

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `LOG_LEVEL` | Set logging verbosity (DEBUG, INFO, WARN, ERROR) | `INFO` | `LOG_LEVEL=DEBUG` |
| `LOG_FORMAT` | Set log output format (pretty, json) | `pretty` | `LOG_FORMAT=json` |
| `ccflare_DEBUG` | Enable debug mode with console output | - | `ccflare_DEBUG=1` |
| `ccflare_DB_PATH` | Custom database file path | Platform-specific | `ccflare_DB_PATH=/var/lib/ccflare/db.sqlite` |
| `CF_PRICING_REFRESH_HOURS` | Hours between pricing data refreshes | `24` | `CF_PRICING_REFRESH_HOURS=12` |
| `CF_STREAM_USAGE_BUFFER_KB` | Stream usage buffer size in KB | `64` | `CF_STREAM_USAGE_BUFFER_KB=128` |
| `CF_STREAM_TIMEOUT_MS` | Stream processing timeout in milliseconds | `60000` (1 minute) | `CF_STREAM_TIMEOUT_MS=120000` |

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

#### Read or update team routing

```http
GET /api/config/team-routing
POST /api/config/team-routing
x-api-key: <admin key>
Content-Type: application/json
```

`POST` replaces the policy object using the snake_case fields shown above and
takes effect for subsequent selection without a server restart. Management
writes require `CF_ADMIN_KEY` through `x-api-key`; do not put that key in the
configuration file.

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
export RETRY_ATTEMPTS=2
export RETRY_DELAY_MS=500
export LOG_LEVEL=WARN  # Reduce logging overhead
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
export RETRY_ATTEMPTS=3
export LOG_LEVEL=INFO
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
export LOG_LEVEL=DEBUG
export LOG_FORMAT=pretty
export ccflare_DEBUG=1
export RETRY_ATTEMPTS=5
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
export LOG_LEVEL=INFO
export LOG_FORMAT=json
```

## Configuration Validation

### Automatic Validation

ccflare performs validation on:

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
   mkdir -p ~/.config/ccflare
   ```

2. Export current configuration:
   ```bash
   curl http://localhost:8080/api/config > ~/.config/ccflare/ccflare.json
   ```

3. Edit and format the file:
   ```bash
   jq '.' ~/.config/ccflare/ccflare.json > temp.json && mv temp.json ~/.config/ccflare/ccflare.json
   ```

### From Older Versions

#### Pre-1.0 to Current

1. **Configuration location**: Move from `~/.ccflare/config.json` to platform-specific paths
2. **Field naming**: Update any deprecated field names (none currently deprecated)
3. **Strategy names**: Only `"session"` strategy is available (must be lowercase)

### Configuration Backup

Always backup your configuration before upgrades:

```bash
cp ~/.config/ccflare/ccflare.json ~/.config/ccflare/ccflare.json.backup
```

### Rollback Procedure

If issues occur after configuration changes:

1. **Via API**: Revert strategy changes using the runtime API
2. **File restoration**: Restore from backup configuration file
3. **Environment override**: Use environment variables to override problematic settings

## Troubleshooting

### Common Issues

1. **Configuration not loading**:
   - Check file permissions: `ls -la ~/.config/ccflare/`
   - Verify JSON syntax: `jq '.' ~/.config/ccflare/ccflare.json`
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
export ccflare_DEBUG=1
export LOG_LEVEL=DEBUG
export LOG_FORMAT=json  # For structured logging
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

Note: Payload retention applies to request/response JSON payloads. Request metadata retention controls how long rows in the `requests` table are kept (affects analytics beyond the window).

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
