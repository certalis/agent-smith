# One shared pool over authenticated HTTPS

Use this deployment when a managed host supports HTTPS but cannot run a VPN.
The HTTPS address is publicly reachable. Inference requires an authorized
device key; management and provider credentials stay on the server. This is an
authenticated public entrance. It does not create a private network.

Keep one Agent-smith process, one normal config and one SQLite database on a
persistent local disk. Start it on loopback with `CF_TRUST_LOOPBACK=false` and
an `additionalUnixSocket` inside its protected state directory. Keep the server's
`CF_PROXY_KEY` and distinct `CF_ADMIN_KEY` private to the host.

## Authorize devices

Give each laptop its own random key (at least 32 printable ASCII characters).
Put the raw key only in that laptop's mode-600 `client.proxy_key_file`.
On the server, set `CF_CLIENT_KEYS_FILE` to an absolute mode-600 JSON file owned
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

## Attach the narrow HTTPS entrance

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
streams responses with backpressure. Client disconnection cancels forwarding.
Requests end after five minutes by default; set `timeoutMs` or `maxBodyBytes`
explicitly if the deployment needs different bounds. Redirects are refused.
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

Before rollout, prove both callers reach authenticated health and make one
approved inference request through the same pool. Public requests with no key,
unknown keys and deleted device keys must receive 401. Management and OAuth
paths must receive 404 at the edge, including with a valid device key. Confirm
streaming and that the configured database path and account state remain single.
