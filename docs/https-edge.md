# One shared pool over authenticated HTTPS

Use this deployment when a managed host supports HTTPS but cannot run a VPN.
The HTTPS address is publicly reachable. Inference requires an authorized
device key; management and provider credentials stay on the server. This is an
authenticated public entrance. It does not create a private network.

## Standalone Render web service

Deploy this repository as a **web service**, with one instance and a persistent
disk mounted at `/var/data`. Build with `bun install --frozen-lockfile && bun run build`
and start with `bun run start:https`. Both Node.js 20+ and Bun are required.
Set the HTTP health-check path to `/readyz`; this returns readiness only, not
account or pool information. Do not use the raw `bun run start` as public ingress.

The launcher runs a Node HTTP entrance behind Render's HTTPS termination and
one supervised Bun pool. It stops accepting public traffic if the pool exits.
Deployments of this service still interrupt active streams; deploying a separate
agents service no longer restarts this pool. Keep one replica: SQLite and OAuth
refresh state are not shared across replicas.

| Setting | Value or default |
| --- | --- |
| `PORT` | Render's public listener, normally `10000` |
| `AGENT_SMITH_PUBLIC_ORIGIN` | Exact HTTPS origin, e.g. `https://pool.example.com`; defaults to `RENDER_EXTERNAL_URL` on Render |
| `AGENT_SMITH_STATE_DIR` | `/var/data/agent-smith/state`, directory mode `0700` |
| `AGENT_SMITH_KEYS_FILE` | `/var/data/agent-smith/keys.json`, regular file mode `0600` |
| `AGENT_SMITH_POOL_PORT` | `8081`, distinct from the public port |
| `AGENT_SMITH_POOL_HOST` | `127.0.0.1`; use `0.0.0.0` only when a trusted private network needs this secondary port |

Provision the keys file on the server with two different random values of at
least 32 printable ASCII characters, under `adminKey` and `proxyKey`. Alternatively,
provide both `AGENT_SMITH_ADMIN_KEY` and `AGENT_SMITH_PROXY_KEY` in the service's secret
environment. Never commit keys. Existing state files must be owner-only regular
files, owned by the service user or readable root-owned files. The launcher
refuses loose permissions and symlinked files rather than migrating them.

Within the state directory, the defaults are `config.json`, `pool.db`,
`clients.json` and the private `control.sock`. Optional absolute overrides are
`AGENT_SMITH_CONFIG_PATH`, `AGENT_SMITH_DB_PATH` and `AGENT_SMITH_CLIENT_KEYS_FILE`.
Provision the normal server configuration and device registry before enabling
traffic. No provider account is automatically enrolled or copied to a client.

A small paid instance with 512 MB RAM is a starting point for a PoC, not a
15–25-agent capacity guarantee. Measure memory, CPU, queueing and active streams
under the actual workload before choosing production capacity.

On Render, only the primary listener receives public traffic. A separate
secondary port can be reached over the [private network](https://render.com/docs/private-network).
An agents scheduler that needs `/api/pool-status` must use that private origin
and the forwarding key. Device keys deliberately cannot read this endpoint.
Never publish the private listener or give agents the administrator key.

## Pool and device setup

Keep one Agent Smith pool process, one normal config and one SQLite database on a
persistent local disk. Start it on loopback with `AGENT_SMITH_TRUST_LOOPBACK=false` and
an `additionalUnixSocket` inside its protected state directory. Keep the server's
`AGENT_SMITH_PROXY_KEY` and distinct `AGENT_SMITH_ADMIN_KEY` private to the host.

## Authorize devices

Give each laptop its own random key (at least 32 printable ASCII characters).
Put the raw key only in that laptop's mode-600 `client.proxy_key_file`.
On the server, set `AGENT_SMITH_CLIENT_KEYS_FILE` to an absolute mode-600 JSON file owned
by the pool process or root. Its values are SHA-256 hex digests of the raw keys,
without a trailing newline:

```json
{
  "laptop-01": "<64 lowercase hex characters>",
  "laptop-02": "<a different SHA-256 digest>"
}
```

Names contain letters, digits, `_` or `-`, up to 64 characters. The registry
holds at most 128 devices and 32 KiB. Missing, invalid, symlinked or loosely
permissioned files deny device access. No raw device key enters the registry.
Write updates atomically in the same protected directory. Every request reloads
the file: deleting a device entry revokes new requests immediately, without
restarting the pool. It does not cancel requests already in flight.

Device keys allow only health, Messages, token counting and Responses. They
cannot read management data or change accounts. This does not add per-device
fairness, quotas or usage attribution.

## Attach the narrow HTTPS entrance to an existing service

The npm package exports a Node-compatible handler for an existing HTTP server.
Render or another HTTPS ingress terminates TLS; the handler forwards exact
inference paths to the protected pool socket and maps `GET /pool-health` to
the pool's authenticated health route:

```js
import { createProxyEdgeHandler } from "@certalis/agent-smith/edge";

const handlePool = createProxyEdgeHandler({
  origin: "https://agents.example.com",
  socketPath: "/var/lib/agent-smith/control.sock",
});
```

Route `/v1/` and `/pool-health` requests from the host's HTTP server to this
handler. It returns 404 for every path or method it does not explicitly allow,
including `/v1/oauth/token` and encoded traversal. Messages and token counting
also accept the SDK's exact `?beta=true` query; other queries are refused. Never forward
`/api`, `/oauth`, the dashboard or the raw Unix socket. The existing host may
keep its own health, webhook and separately secured enrollment routes.

The handler checks the exact Host and any Origin, strips cookies and forwarded
headers, requires authentication, caps request bytes, preserves body bytes and
streams responses with backpressure. Headers reach the private pool before
upload data, so unknown device keys can be rejected without waiting for a body.
The handler allows at most 128 active private requests; further requests receive
503 without opening a private connection. Set `maxConcurrentRequests` to change
this per-handler bound; it is not a per-device quota.
Client disconnection or the edge deadline cancels the provider fetch, including
background response consumption. Requests end after five minutes by default;
set `timeoutMs` or `maxBodyBytes` explicitly if the deployment needs different
bounds. Redirects are refused.
WebSocket upgrades are unsupported at this entrance; the shipped Codex wrapper
uses HTTP Responses. Admin access continues through the private socket.

The host process must be allowed to open that socket, but agent job users must
not be able to replace it or traverse its parent. Do not replace the Unix socket
with an unverified loopback TCP connection: another local user could capture
credentials after a pool crash.

## Configure and prove

Use the shipped [HTTPS client config](../examples/config/https-client.json).
Edit its origin and key-file path, set `client.enabled: true`, then run
`agent-smith install-client`. Routing is off by default. Set the flag to `false`
and run that command again to restore ordinary local Claude Code/Codex.
Clients keep no provider token, pool database or local refresher. The server's
existing agent jobs can keep using their private forwarding key and local route.

The Claude wrapper clears `ANTHROPIC_AUTH_TOKEN` and supplies only the device key
as `ANTHROPIC_API_KEY`. The key authenticates to Agent Smith, not Anthropic.
Claude may describe this gateway mode as API usage billing; the server's selected
provider/account determines the actual upstream authentication and billing.
An enabled wrapper uses the pool directly, not the local account first.

Claude.ai cloud connectors are a separate feature: Claude Code normally does not
load them while gateway auth is active, even if a personal login is saved. See
[Claude's connector authentication rules](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claudeai).
Agent Smith does not bypass this restriction or transfer the personal login to
the server. Separately configured MCP servers are not disabled by this wrapper,
but any tool results included in model context still pass through the pool.
Conversation affinity is not an owner-only privacy guarantee: failover can move
context to another eligible seat. Do not assume only the tool's own HTTP call
needs protection; later model requests may contain the same tool results.

Before rollout, prove both callers reach authenticated health and make one
approved inference request through the same pool. Public requests with no key,
unknown keys and deleted device keys must receive 401. Management and OAuth
paths must receive 404 at the edge, including with a valid device key. Confirm
streaming and that the configured database path and account state remain single.
