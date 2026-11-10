# agent-smith HTTP API Documentation

## Quick Start

```bash
# Check health status
curl http://localhost:8080/health

# Proxy a request to Anthropic
curl -X POST http://localhost:8080/v1/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'

# Proxy a request to OpenAI
curl -X POST http://localhost:8080/v1/openai/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# List all accounts
curl http://localhost:8080/api/accounts

# View dashboard
open http://localhost:8080
```

## Overview

agent-smith provides a RESTful HTTP API for managing accounts, monitoring usage, and proxying requests to Anthropic and OpenAI. The API runs on port 8080 by default. Direct loopback provider requests may be keyless; externally exposed or forwarded requests require `AGENT_SMITH_PROXY_KEY` in `x-api-key`. Every mutating `/api` request requires a configured `AGENT_SMITH_ADMIN_KEY` in that header.

### Base URL

For the [HTTPS device entrance](https-edge.md), the public health route is
`GET /pool-health`; it maps to `/health` on the private pool. Only exact Messages,
token-counting and Responses routes are forwarded. Device keys work in
`x-api-key` (or Bearer on Responses) and cannot access management endpoints.
This entrance does not expose the management API described below.

```
http://localhost:8080
```

### Content Type

All API responses are in JSON format with `Content-Type: application/json`.

## Endpoints

### Deployment drain (private, administrator only)

`POST /api/drain` pauses new inference for two minutes; repeating it renews
that lease. `GET /api/drain` reads the current state without renewing it.
`DELETE /api/drain` cancels the pause. All three require the administrator key
in `x-api-key`, including reads; proxy and device keys cannot control a rollout.
The HTTPS entrance never forwards these paths.

Responses contain `draining`, `expiresAt` (epoch milliseconds or `null`),
`activeRequests`, and `activeWebSockets`. Activity covers both private listeners
and includes open response streams; the control request itself is excluded.
Health checks and management continue to work during the pause. New inference
receives 503 with `Retry-After: 30` before provider forwarding; current responses
are not cancelled or replayed. The pause is in memory: cancellation, lease
expiry or restart restores service without editing accounts or the database.
`GET /api/pool-status` also returns 503 during the pause so schedulers stop
starting jobs; ordinary health stays 200.

See the [bounded rollout procedure](https-edge.md#deploy-with-less-interruption).

### Private Claude seat enrollment (opt-in)

Set `AGENT_SMITH_ENROLLMENT_ORIGIN` to the exact external HTTPS origin (no trailing slash,
path or credentials). Unset disables every enrollment route. HTTP loopback origins
are accepted only for synthetic local tests. Keep normal admin/proxy keys and
private listener isolation in place. Invitations also need
`providers.claude-code.enabled: true` in the config; while Claude Code is
disabled, issuing one returns 400.

| Method / path | Authorization | Body / result |
|---|---|---|
| `POST /api/enrollment-invitations` | Existing admin key | Optional `name`, `email` (expected Claude email), `contactEmail`, `slackUserId`; returns `url`, `expiresAt` |
| `POST /api/enrollment-emails` | Existing admin key | Optional `add`, `remove` email lists; returns the whole `emails` list. `{}` only reads it |
| `GET /pool-enroll` | Configured Host | Static page: the stable link; does not consume an invite |
| `POST /pool-enroll/request` | Exact Host/Origin + listed email | `{email}` → invitation `token`, normalized `email`, `expiresAt`; 403 when the email is not listed |
| `POST /pool-enroll/start` | Exact Host/Origin + invitation | `{token}` → `token`, `authUrl`, `expiresAt` |
| `POST /pool-enroll/verify` | Exact Host/Origin + login capability | `{token, code}` → new `token`, authenticated `email`, `expiresAt`; no account saved |
| `POST /pool-enroll/confirm` | Exact Host/Origin + verified capability | `{token, consent: true}` → `connected: true`, seat-specific removal `token`, `expiresAt` |
| `POST /pool-enroll/disconnect` | Exact Host/Origin + removal capability | `{token}` → `disconnected: true`, fresh invitation `token`, `expiresAt` |

**Stable link.** `/pool-enroll` without a fragment asks for an email. When that
email is on `enrollment_emails`, it returns a 10-minute invitation bound to it: the
seat is named after the email's local part, the email becomes its reminder contact,
and verify refuses any Claude account whose email differs. The typed email only
selects the invitation; the Claude sign-in proves it. An email whose seat already
exists returns 409. The list is edited live and persisted; removing an email stops
new requests at once, without touching seats already connected. It is POST-only
because the proxy key may read every `GET /api/*` route.

JSON POST bodies are streaming-capped at 8 KiB. Issuing `{}` is supported: the
operator delegates seat choice to the private link's holder. The page always shows
the Claude-authenticated email before confirmation; a missing profile email fails
closed. Optional reminder contacts neither restrict sign-in nor send messages.

Invitation secrets use URL fragments and are removed from browser history on load.
Send them privately; never paste codes/tokens into chat or logs. Invitations expire
after 24 hours, then each login/confirmation capability lasts 10 minutes. Each is
one-use, including failed attempts; reload/restart requires a new invitation.
Reissuing the same pending label revokes the older link; an in-flight exchange or
existing account returns 409. At most 100 pending flows are held in process memory.
Invitation PKCE state is also process-local: it never enters the ordinary
`auth_sessions` table and cannot be completed through a legacy OAuth callback,
before or after a restart.

After confirmation, the success page offers **Disconnect**. Its
24-hour removal capability is bound to the created account ID and provider UUID;
an old capability cannot remove a subsequently re-enrolled seat. Disconnect
deletes the account credentials, private contacts, conversation pins and that
allowlist membership, preserving other seats and routing settings. A failed
membership-file write rolls back deletion and leaves removal retryable. Success
returns a fresh one-use invitation with the original restrictions for another
sign-in. Disconnect needs this page still open: after a reload, expiry or server
restart, removal is operator cleanup. Removal does not cancel a subscription, log
the browser out of Claude, remotely revoke provider tokens, or stop an in-flight
request. An interruption between config rename and SQLite deletion commit can
leave a stored account without membership; the operator must inspect it before
restoring traffic.

No reusable general join link, account listings, dashboard or inference access is
granted. The new identity is added to the allowlist without changing its enabled
flag or limits. A membership-file write failure rolls back the account/contact
transaction; never retry a reported persistence error blindly. An interruption
between config rename and SQLite commit can leave an allowlisted UUID with no
account, which cannot serve requests; the operator must inspect before retrying.
Existing-account reauthentication and reminder delivery are not implemented here.

### Health Check

#### GET /health

Check the health status of the agent-smith service.

**Response:**
```json
{
  "status": "ok",
  "accounts": 5,
  "timestamp": "2024-12-17T10:30:45.123Z",
  "strategy": "session",
  "providers": ["anthropic", "openai"]
}
```

**Example:**
```bash
curl http://localhost:8080/health
```

---

### Provider Proxy

#### /v1/{provider}/* (All Methods)

Proxy requests to upstream provider APIs. The `/v1/{provider}` prefix is stripped exactly once before forwarding upstream. Requests are routed using the configured load balancing strategy across accounts matching the target provider.

**Supported Providers:**
- `/v1/anthropic/*` → `https://api.anthropic.com/*`
- `/v1/openai/*` → `https://api.openai.com/v1/*`

**Headers:**
- All standard provider API headers are supported
- `Authorization` header is managed by agent-smith (no need to provide)

**Request Body:**
Same as the upstream provider API requirements for the specific endpoint.

**Response:**
Proxied response from the upstream provider API, including streaming responses.

**Automatic Failover:**
If a request fails or an account is rate limited, agent-smith automatically retries with the next available account according to the configured load balancing strategy. This ensures high availability and reliability.

**Examples:**
```bash
# Anthropic
curl -X POST http://localhost:8080/v1/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'

# OpenAI chat completions
curl -X POST http://localhost:8080/v1/openai/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# OpenAI responses
curl -X POST http://localhost:8080/v1/openai/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "input": "Hello!"
  }'
```

---


---

### Pool capacity

`GET /api/pool-status?provider=claude-code` is a read-only scheduling snapshot.
Send `x-api-key` with the forwarding key; disable loopback trust on hosted pools.
The response uses `Cache-Control: no-store` and has no account identities or credentials:

```json
{
  "version": 1,
  "provider": "claude-code",
  "routingEnabled": true,
  "eligibleAccounts": 2,
  "retryAtMs": null,
  "holdSeconds": 0,
  "admissionWaitMs": 1000
}
```

Only available, allowlisted OAuth seats count. Quota thresholds and owner reserve
reuse routing's eligibility rules. Disabled routing reports zero. Optional `model`
includes that family's weekly quota; omission considers shared windows only.
`retryAtMs` is, when no seat is eligible, the soonest a seat may serve again, in
epoch milliseconds: once its last blocking quota window resets and its cooldown
ends. It is null when no seat is quota-blocked or no reset is known. It is a
recheck hint, not guaranteed capacity; paused seats never count. Reads perform no admission,
conversation pin, token refresh or quota probe. Invalid/missing provider or an
empty/overlong model returns 400.

### Account Management

#### GET /api/accounts

List all configured accounts with their current status.

**Response:**
```json
[
  {
    "id": "uuid-here",
    "name": "account1",
    "provider": "anthropic",
    "auth_method": "api_key",
    "base_url": null,
    "requestCount": 150,
    "totalRequests": 1500,
    "lastUsed": "2024-12-17T10:25:30.123Z",
    "created": "2024-12-01T08:00:00.000Z",
    "weight": 1,
    "paused": false,
    "tokenStatus": "valid",
    "tokenExpiresAt": null,
    "rateLimitStatus": {
      "code": "ok",
      "isLimited": false,
      "until": null
    },
    "rateLimitReset": "2024-12-17T10:30:00.000Z",
    "rateLimitRemaining": 100,
    "sessionInfo": {
      "active": true,
      "startedAt": "2024-12-17T10:00:00.000Z",
      "requestCount": 25
    }
  }
]
```

**Example:**
```bash
curl http://localhost:8080/api/accounts
```

---

### Auth Flow

OAuth and auth endpoints are provider-scoped. The `{provider}` path segment determines which provider's OAuth flow is used (e.g., `anthropic`, `openai`, `claude-code`, `codex`).

#### POST /api/auth/{provider}/init

Initialize an OAuth flow for adding a new account.

**Request:**
```json
{
  "name": "myaccount"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OAuth flow initiated for 'myaccount'",
  "data": {
    "authUrl": "https://claude.ai/oauth/authorize?...",
    "sessionId": "uuid-here",
    "provider": "claude-code"
  }
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/auth/claude-code/init \
  -H "Content-Type: application/json" \
  -d '{"name": "myaccount"}'
```

#### POST /api/auth/{provider}/complete

Complete the OAuth flow after user authorization.

**Request:**
```json
{
  "sessionId": "uuid-from-init-response",
  "code": "authorization-code-from-oauth"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Account 'myaccount' added successfully!",
  "data": {
    "provider": "claude-code"
  }
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/auth/claude-code/complete \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "uuid-here", "code": "auth-code"}'
```

#### GET /api/auth/session/{sessionId}/status

Check the status of an in-progress OAuth session.

**Example:**
```bash
curl http://localhost:8080/api/auth/session/uuid-here/status
```

#### GET /oauth/{provider}/callback

Browser redirect target for the OAuth flow. This is the callback URL that the OAuth provider redirects to after the user authorizes. Not called directly by API consumers.

---

### Account Management

#### DELETE /api/accounts/:accountId

Remove an account.

**Response:**
```json
{
  "success": true,
  "message": "Account 'account-name' removed successfully"
}
```

**Example:**
```bash
curl -X DELETE http://localhost:8080/api/accounts/uuid-here
```

#### PATCH /api/accounts/:accountId

Update an account (e.g., rename or change `base_url`).

**Request:**
```json
{
  "name": "new-name",
  "base_url": "https://custom-endpoint.example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Account updated"
}
```

**Example:**
```bash
curl -X PATCH http://localhost:8080/api/accounts/uuid-here \
  -H "Content-Type: application/json" \
  -d '{"name": "new-name"}'
```

#### POST /api/accounts/:accountId/rename

Rename an account.

**Request:**
```json
{
  "name": "new-name"
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/accounts/uuid-here/rename \
  -H "Content-Type: application/json" \
  -d '{"name": "new-name"}'
```

#### POST /api/accounts/:accountId/pause

Pause an account temporarily.

**Response:**
```json
{
  "success": true,
  "message": "Account 'myaccount' paused"
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/accounts/uuid-here/pause
```

#### POST /api/accounts/:accountId/resume

Resume a paused account.

**Response:**
```json
{
  "success": true,
  "message": "Account 'myaccount' resumed"
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/accounts/uuid-here/resume
```

---

### Statistics

#### GET /api/stats

Get overall usage statistics.

**Response:**
```json
{
  "totalRequests": 5000,
  "successRate": 98.5,
  "activeAccounts": 4,
  "avgResponseTime": 1250.5,
  "totalTokens": 1500000,
  "totalCostUsd": 125.50,
  "avgTokensPerSecond": null,
  "topModels": [
    {"model": "claude-3-opus-20240229", "count": 3000},
    {"model": "claude-3-sonnet-20240229", "count": 2000}
  ]
}
```

**Example:**
```bash
curl http://localhost:8080/api/stats
```

#### POST /api/stats/reset

Reset all usage statistics.

**Response:**
```json
{
  "success": true,
  "message": "Statistics reset successfully"
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/stats/reset
```

---

### Request History

#### GET /api/requests

Get recent request summary.

**Query Parameters:**
- `limit` - Number of requests to return (default: 50)

**Response:**
```json
[
  {
    "id": "request-uuid",
    "timestamp": "2024-12-17T10:30:45.123Z",
    "method": "POST",
    "path": "/v1/anthropic/v1/messages",
    "accountUsed": "account1",
    "statusCode": 200,
    "success": true,
    "errorMessage": null,
    "responseTimeMs": 1234,
    "failoverAttempts": 0,
    "model": "claude-sonnet-4-20250514",
    "promptTokens": 50,
    "completionTokens": 100,
    "totalTokens": 150,
    "inputTokens": 50,
    "outputTokens": 100,
    "cacheReadInputTokens": 0,
    "cacheCreationInputTokens": 0,
    "costUsd": 0.0125,
    "agentUsed": null,
    "tokensPerSecond": null
  }
]
```

**Example:**
```bash
curl "http://localhost:8080/api/requests?limit=100"
```

#### GET /api/requests/detail

Get detailed request information, including the metadata payload. `request.body` and `response.body` are always `null`: prompt and response bodies are not stored.

**Query Parameters:**
- `limit` - Number of requests to return (default: 100)

**Response:**
```json
[
  {
    "id": "request-uuid",
    "timestamp": "2024-12-17T10:30:45.123Z",
    "method": "POST",
    "path": "/v1/anthropic/v1/messages",
    "accountUsed": "account1",
    "statusCode": 200,
    "success": true,
    "payload": {
      "request": {
        "headers": {...},
        "body": null
      },
      "response": {
        "status": 200,
        "headers": {...},
        "body": null
      },
      "meta": {
        "accountId": "uuid",
        "accountName": "account1",
        "retry": 0,
        "timestamp": 1234567890,
        "success": true,
        "rateLimited": false,
        "accountsAttempted": 1
      }
    }
  }
]
```

**Example:**
```bash
curl "http://localhost:8080/api/requests/detail?limit=10"
```

#### GET /api/requests/stream

Stream real-time request events via Server-Sent Events (SSE).

**Response:** SSE stream with request events

**Example:**
```bash
curl -N http://localhost:8080/api/requests/stream
```

---

### Configuration

#### GET /api/config

Get current configuration.

**Response:**
```json
{
  "lbStrategy": "session",
  "port": 8080,
  "sessionDurationMs": 18000000
}
```

**Example:**
```bash
curl http://localhost:8080/api/config
```

#### GET /api/config/strategy

Get current load balancing strategy.

**Response:**
```json
{
  "strategy": "session"
}
```

**Example:**
```bash
curl http://localhost:8080/api/config/strategy
```

#### POST /api/config/strategy

Update load balancing strategy.

**Request:**
```json
{
  "strategy": "session"
}
```

**Response:**
```json
{
  "success": true,
  "strategy": "session"
}
```

**Available Strategies:**
- `session` - compatibility name for quota- and priority-ordered routing; it does not maintain a five-hour account session

**Note:** `session` is the compatibility strategy name. W2 routing uses quota and priority rather than a five-hour sticky session.

**Example:**
```bash
curl -X POST http://localhost:8080/api/config/strategy \
  -H "Content-Type: application/json" \
  -d '{"strategy": "session"}'
```

#### GET /api/strategies

List all available load balancing strategies.

**Response:**
```json
["session"]
```

**Example:**
```bash
curl http://localhost:8080/api/strategies
```

---

### Analytics

#### GET /api/analytics

Get detailed analytics data.

**Query Parameters:**
- `range` - Time range: `1h`, `6h`, `24h`, `7d`, `30d` (default: `24h`)
- `accounts` - Filter by account names (comma-separated list)
- `models` - Filter by model names (comma-separated list)
- `status` - Filter by request status: `all`, `success`, `error` (default: `all`)
- `mode` - Display mode: `normal`, `cumulative` (default: `normal`). Cumulative mode shows running totals over time
- `modelBreakdown` - Include per-model time series data: `true`, `false` (default: `false`)

**Response:**
```json
{
  "meta": {
    "range": "24h",
    "bucket": "1h",
    "cumulative": false
  },
  "totals": {
    "requests": 5000,
    "successRate": 98.5,
    "activeAccounts": 4,
    "avgResponseTime": 1250.5,
    "totalTokens": 1500000,
    "totalCostUsd": 125.50,
    "avgTokensPerSecond": null
  },
  "timeSeries": [
    {
      "ts": 1734430800000,
      "requests": 100,
      "tokens": 15000,
      "costUsd": 1.25,
      "successRate": 98,
      "errorRate": 2,
      "cacheHitRate": 15,
      "avgResponseTime": 1200,
      "avgTokensPerSecond": null
    }
  ],
  "tokenBreakdown": {
    "inputTokens": 500000,
    "cacheReadInputTokens": 100000,
    "cacheCreationInputTokens": 50000,
    "outputTokens": 850000
  },
  "modelDistribution": [
    {"model": "claude-3-opus-20240229", "count": 3000}
  ],
  "accountPerformance": [
    {"name": "account1", "requests": 2500, "successRate": 99}
  ],
  "costByModel": [
    {"model": "claude-3-opus-20240229", "costUsd": 100.50, "requests": 3000, "totalTokens": 1200000}
  ],
  "modelPerformance": [
    {
      "model": "claude-3-opus-20240229",
      "avgResponseTime": 1300,
      "p95ResponseTime": 2500,
      "errorRate": 1.5,
      "avgTokensPerSecond": null,
      "minTokensPerSecond": null,
      "maxTokensPerSecond": null
    }
  ]
}
```

**Examples:**
```bash
# Basic analytics for last 7 days
curl "http://localhost:8080/api/analytics?range=7d"

# Analytics filtered by specific accounts
curl "http://localhost:8080/api/analytics?range=24h&accounts=account1,account2"

# Analytics for specific models with success status only
curl "http://localhost:8080/api/analytics?range=24h&models=claude-3-opus-20240229,claude-3-sonnet-20240229&status=success"

# Combined filters
curl "http://localhost:8080/api/analytics?range=7d&accounts=premium1,premium2&models=claude-3-opus-20240229&status=error"
```

---

### Maintenance

#### POST /api/maintenance/cleanup

Run data cleanup based on configured retention settings.

**Example:**
```bash
curl -X POST http://localhost:8080/api/maintenance/cleanup
```

#### POST /api/maintenance/compact

Compact the database to reclaim disk space.

**Example:**
```bash
curl -X POST http://localhost:8080/api/maintenance/compact
```

---

### Data Retention

#### GET /api/config/retention

Get current data retention settings.

**Response:**
```json
{
  "payloadDays": 7,
  "requestDays": 30
}
```

**Example:**
```bash
curl http://localhost:8080/api/config/retention
```

#### POST /api/config/retention

Update data retention settings.

**Request:**
```json
{
  "payloadDays": 14,
  "requestDays": 90
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/config/retention \
  -H "Content-Type: application/json" \
  -d '{"payloadDays": 14, "requestDays": 90}'
```

---

### Logs

#### GET /api/logs/stream

Stream real-time logs via Server-Sent Events (SSE).

**Response:** SSE stream with log events

**Example:**
```bash
curl -N http://localhost:8080/api/logs/stream
```

#### GET /api/logs/history

Get historical logs.

**Response:**
```json
[
  {
    "timestamp": "2024-12-17T10:30:45.123Z",
    "level": "info",
    "component": "proxy",
    "message": "Request completed",
    "metadata": {...}
  }
]
```

**Example:**
```bash
curl http://localhost:8080/api/logs/history
```

---

## Error Handling

All API errors follow a consistent format:

```json
{
  "error": "Error message",
  "details": {
    // Optional additional error details
  }
}
```

### Common Status Codes

- **200 OK** - Request successful
- **400 Bad Request** - Invalid request parameters
- **404 Not Found** - Resource not found
- **429 Too Many Requests** - Rate limited
- **500 Internal Server Error** - Server error
- **502 Bad Gateway** - Upstream provider error
- **503 Service Unavailable** - All accounts failed

### Rate Limiting

When an account hits rate limits, agent-smith automatically fails over to the next available account. If all accounts are rate limited, a 503 error is returned.

Rate limit information is included in account responses:
- `rateLimitStatus` - Current status (e.g., "allowed", "allowed_warning", "rate_limited")
- `rateLimitReset` - When the rate limit resets
- `rateLimitRemaining` - Remaining requests (if available)

---

## Streaming Responses

The proxy endpoints support streaming responses for compatible Claude API calls. When making a streaming request:

1. Include `"stream": true` in your request body
2. The response will be `Content-Type: text/event-stream`
3. Each chunk is delivered as a Server-Sent Event

**Streaming Responses:**
agent-smith reads the stream in the background for token usage and response IDs only:
- The client's stream is not altered
- Response bodies are not stored; the request history keeps `response.body: null`

**Example:**
```bash
curl -X POST http://localhost:8080/v1/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Write a poem"}],
    "max_tokens": 100,
    "stream": true
  }'
```

---

## Dashboard

A web dashboard is available at:

```
http://localhost:8080/          # Dashboard
```

The dashboard provides a visual interface for:
- Monitoring account status and usage
- Viewing real-time analytics
- Managing configuration
- Examining request history

---

## Configuration

### Environment Variables

agent-smith can be configured using the following environment variables:

- `PORT` - Server port (default: 8080)
- `AGENT_SMITH_LB_STRATEGY` - Legacy session-strategy setting; unused by quota- and priority-ordered routing (default: session)
- `AGENT_SMITH_SESSION_DURATION_MS` - Legacy session-strategy duration; unused by the quota-aware proxy kernel (default: 18000000 / 5 hours)
- `AGENT_SMITH_CLIENT_ID` - OAuth client ID for Anthropic authentication (default: 9d1c250a-e61b-44d9-88ed-5944d1962f5e)
- `AGENT_SMITH_RETRY_ATTEMPTS` - Number of retry attempts for failed requests (default: 3)
- `AGENT_SMITH_RETRY_DELAY_MS` - Initial delay between retries in milliseconds (default: 1000)
- `AGENT_SMITH_RETRY_BACKOFF` - Exponential backoff multiplier for retries (default: 2)

### Configuration File

In addition to environment variables, agent-smith supports configuration through a JSON file. The config file location varies by platform:
- macOS/Linux: `~/.config/agent-smith/agent-smith.json` (or `$XDG_CONFIG_HOME/agent-smith/agent-smith.json`)
- Windows: `%LOCALAPPDATA%\agent-smith\agent-smith.json` (or `%APPDATA%\agent-smith\agent-smith.json`)

**Supported Configuration Keys:**
```json
{
  "client_id": "your-oauth-client-id",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "port": 8080,
  "stream_body_max_bytes": 262144
}
```

**Note:** Environment variables take precedence over config file settings.

### Legacy Session Settings

`AGENT_SMITH_LB_STRATEGY` and `AGENT_SMITH_SESSION_DURATION_MS` remain accepted for configuration compatibility only. They do not change quota-aware account selection, cooldowns, or OAuth token expiry.

## Notes

1. **Authentication boundary**: Direct loopback provider requests may be keyless; forwarded and external requests require `AGENT_SMITH_PROXY_KEY`. Every mutating management request requires `AGENT_SMITH_ADMIN_KEY`.

2. **Automatic Failover**: When a request fails or an account is rate limited, agent-smith automatically tries the next available account. If no account is eligible, requests are refused with HTTP 503 and never forwarded without credentials.

3. **Token Refresh**: Access tokens are automatically refreshed when they expire.

4. **Request Logging**: All requests are logged with detailed metrics including tokens used, cost, and response times. Database writes are performed asynchronously to avoid blocking request processing.

5. **Affinity**: W2 preserves only explicit Claude message-thread continuations. Conversation pinning and new-conversation distribution arrive in W3.

6. **Rate Limit Tracking**: Rate limit information is automatically extracted from responses and stored for each account, including reset times and remaining requests.

7. **Provider Filtering**: Accounts are automatically filtered by provider when selecting for requests, ensuring compatibility.
