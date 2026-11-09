# agent-smith

**A proof-of-concept proxy and provider pool for Claude Code and Codex.**

> [!WARNING]
> **This is a proof of concept for ideation, not a product.** It exists to
> explore an idea and start conversations.
>
> - **No warranty, no support, no stability.** It may change or disappear at any
>   time.
> - **Subscription sign-ins are off by default.** Anthropic's and OpenAI's terms
>   restrict using Claude or ChatGPT plan credentials through a tool like this:
>   read [Subscription sign-ins and provider terms](#subscription-sign-ins-and-provider-terms)
>   before enabling one. You alone are responsible for complying with your
>   providers' terms.
> - Not affiliated with, endorsed by or sponsored by Anthropic or OpenAI.

Claude Code and Codex keep talking their own protocol. agent-smith sits between
them and the provider: it chooses a provider from the pool you configure, then
an account inside that provider, watches the quota each provider reports, and
fails over when one cannot serve.

## How it works

- **A pool of providers per client protocol.** Claude Code speaks
  `anthropic-messages`; Codex speaks `openai-responses`. Each protocol gets an
  ordered list of providers.
- **Each provider is a built-in strategy** (`anthropic-api`, `openai-api`,
  `claude-code`, `codex`). It knows how to authenticate, how to read its quota
  signals, and how to choose between its own accounts.
- **Each provider holds its accounts**: API keys, or subscription sign-ins once
  you enable them.

Nothing is translated between protocols: a provider only serves clients that
speak its protocol.

## Install

You need [Bun](https://bun.sh) 1.2.8 or newer on your `PATH` and a macOS or Linux
shell.

```bash
bun add -g @certalis/agent-smith   # or: npm install -g @certalis/agent-smith
agent-smith
```

Or run it once without installing: `bunx @certalis/agent-smith`. To work from
source, clone this repository, then run `bun install && bun run ccflare`.

A host that supervises agent-smith itself can start the server in its own Bun
process, without the dashboard and with a private Unix socket beside the TCP port:

```js
import startServer from "@certalis/agent-smith/server";

startServer({
  port: 8081,
  withDashboard: false,
  additionalUnixSocket: "/absolute/path/control.sock",
});
```

## Quick start: Claude Code with an Anthropic API key

1. Create the config file (see [Configuration](#configuration)) with a pool for
   Claude Code's protocol:

   ```json
   {
     "provider_pools": {
       "anthropic-messages": ["anthropic"]
     }
   }
   ```

2. Run `agent-smith`. The terminal screen, **Local Pool**, opens; keep it
   running while you use the pool.
3. Press `a`, name the account, and add your Anthropic API key. From a script:
   `agent-smith --add-account work --provider anthropic`.
4. Press `e` and confirm **Enable local client routing**. agent-smith writes small
   wrappers in its own config directory and adds one marked `PATH` entry to your
   shell profile; your real `claude` and `codex` programs are untouched.
5. Open a **new terminal** and run `claude` as usual. Press `e` again to remove
   the wrappers and the `PATH` entry.

Codex works the same way with an OpenAI API key and an `openai-responses` pool.

## Connect an authorized caller to a shared pool

The agents service and laptops can use one server-side pool through the
[authenticated HTTPS entrance](docs/https-edge.md) on managed HTTP hosts such as
Render. HTTPS needs no VPN or extra server: an existing web service forwards
only inference to the pool's private socket. Each device has its own revocable
key; provider tokens and the single database stay on the server.

Device keys allow independent revocation and cannot read management data.
This does not add per-client fairness or budgets.

Copy [`https-client.json`](examples/config/https-client.json) into your private
Agent-smith config. Put the device key in the owner-only file named by
`proxy_key_file`, not in the JSON or a shell profile. `base_url` is the endpoint
visible to your machine, not a second pool. The key can spend from the pool, but
cannot administer it. Remote client routing is off by default: set
`client.enabled` to `true` when this machine should use the shared pool.

An SSH tunnel remains an option for development. Use
[`team-client.json`](examples/config/team-client.json) and forward its local port
to the private server:

```bash
ssh -N -L 18181:127.0.0.1:8080 agent-smith-pool
```

Then apply the flag with the normal client setup command:

```bash
agent-smith install-client
```

Open a new terminal and use `claude` or `codex` normally. The wrappers only add
their own marked `PATH` entry; they do not replace the real binaries or start a
second proxy. The forwarding key is for inference, not dashboard or management
access.

To switch back to ordinary local Claude Code/Codex, set `client.enabled` to
`false` and run `agent-smith install-client` again. It removes only its wrappers
and marked shell entry; it does not change the real clients or their credentials.

## Configuration

The config file is JSON, read at startup from:

- `~/.config/ccflare/ccflare.json` (or `$XDG_CONFIG_HOME/ccflare/ccflare.json`)
  on macOS and Linux,
- or the path in `ccflare_CONFIG_PATH`.

Restart agent-smith after changing `providers`, `provider_pools`, `alerts` or
`block_when_all_full`.

| Key | What it does |
|---|---|
| `providers.<name>.enabled` | Turns a provider's routes on or off. By default `anthropic` and `openai` are on, and `claude-code` and `codex` are off. |
| `providers.<name>.strategy` | The built-in strategy: `anthropic-api`, `openai-api`, `claude-code` or `codex`. Required for a provider name you add yourself. |
| `providers.<name>.base_url` | The upstream URL, for an endpoint compatible with one of the strategies. |
| `providers.<name>.models` | The models a provider serves, as `"client model": "provider model"`. A trailing `*` matches a prefix. Without it, the provider serves every model name unchanged. |
| `provider_pools.<protocol>` | The ordered providers for `anthropic-messages` or `openai-responses`. Clients reach it at `/v1/pool/<protocol>/*`, and the local wrappers use it automatically. |
| `client` | The Agent-smith origin and forwarding key used by `agent-smith install-client`. It is for this machine only; it does not define providers or a separate pool. |
| `team_routing` | Which subscription accounts may share a pool, and their usage caps. See the [configuration guide](docs/configuration.md#team-routing). |
| `alerts` | A Slack webhook or bot token and/or an email address that hear when a seat spends extra usage and when every account is full. A filled value turns its channel on. See [Alerts](docs/configuration.md#alerts). |
| `block_when_all_full` | `true` by default: when every account is full, every request is refused until the soonest reset, so none spends extra usage. |

Every key, the environment variables and the HTTP API are in the
[configuration guide](docs/configuration.md).

### Examples

Each example is a complete config file, also in [`examples/config/`](examples/config/).

**Claude Code with an Anthropic API key**
([`anthropic-api-key.json`](examples/config/anthropic-api-key.json)):

```json
{
  "provider_pools": {
    "anthropic-messages": ["anthropic"]
  }
}
```

**Codex with an OpenAI API key**
([`openai-api-key.json`](examples/config/openai-api-key.json)):

```json
{
  "provider_pools": {
    "openai-responses": ["openai"]
  }
}
```

**An Anthropic-compatible endpoint as fallback**
([`compatible-endpoint-fallback.json`](examples/config/compatible-endpoint-fallback.json)).
Requests go to Anthropic first. When Anthropic cannot serve, Sonnet requests move
to `acme` and are sent as `acme-large`. `acme` serves no other model.

```json
{
  "providers": {
    "acme": {
      "enabled": true,
      "strategy": "anthropic-api",
      "base_url": "https://api.acme.example",
      "models": { "claude-sonnet-*": "acme-large" }
    }
  },
  "provider_pools": {
    "anthropic-messages": ["anthropic", "acme"]
  }
}
```

**A laptop using a private shared pool**
([`team-client.json`](examples/config/team-client.json)). The example uses an
SSH-local port; use the direct private origin instead on a host that can reach
the pool without SSH.

```json
{
  "client": {
    "enabled": false,
    "base_url": "http://127.0.0.1:18181",
    "proxy_key_file": "~/.config/ccflare/team-pool.key"
  }
}
```

The Claude Code and Codex subscription examples are in
[Subscription sign-ins and provider terms](#subscription-sign-ins-and-provider-terms).

## How usage is watched

Each provider reads its own quota signals from the responses it gets:

- **Subscription providers** read the 5-hour and weekly windows.
- **API-key providers** read the provider's rate-limit headers and its 429
  answers.

The Local Pool screen and the dashboard show the latest values. A new account
shows `limits not observed yet` until a response carries quota headers;
agent-smith never invents a zero limit. Several API keys from one organisation
share that organisation's limits, so adding them adds no capacity.

## How failover works

- **Inside a provider**, an account at its quota threshold is skipped. A
  server error before any output may take one hop to another eligible account.
- **Across providers**, a pool moves to its next provider only when the current
  one has no eligible account, or has no eligible account left for that one
  server-error hop. It moves at most once per request.
- A per-minute rate limit never moves a request to another provider, and
  nothing moves once output has started reaching the client.
- A conversation stays on its account while that account is eligible. Moving
  provider loses the prompt cache and can change model behaviour and cost.
- If no provider in the pool serves the requested model, agent-smith returns
  `400` naming `provider_pools.<protocol>`.
- Direct routes, `/v1/<provider>/*`, never use a pool.

Details: [load balancing](docs/load-balancing.md).

## Subscription sign-ins and provider terms

> [!CAUTION]
> `claude-code` signs in to a Claude subscription and `codex` signs in to a
> ChatGPT account. agent-smith then **stores the resulting tokens and routes
> requests through them**. Both are **disabled by default**. The provider terms
> below restrict this use. agent-smith makes **no claim that it is allowed**,
> and the two configs further down are **examples only**, not recommendations.
> If you enable either sign-in, that is your decision and your responsibility.

These are quoted word for word, as read on **30–31 October 2026**. Check the
current versions before acting on them.

**Anthropic, [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
"Authentication and credential use":**

> OAuth authentication is intended exclusively for purchasers of Claude Free,
> Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to
> support ordinary use of Claude Code and other native Anthropic applications.

> Anthropic does not permit third-party developers to offer Claude.ai login into
> their own applications, or to route requests through Free, Pro, Max, or Ultra
> plan credentials on behalf of their users. Moreover, developers may not
> collect, store, or intermediate Claude.ai credentials or session tokens —
> sign-in to a Claude account must complete through Anthropic’s own flow.

> Anthropic reserves the right to take measures to enforce these restrictions
> and may do so without prior notice.

**Anthropic, [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms)
(effective 8 October 2025):**

> You may not share your Account login information, Anthropic API key, or
> Account credentials with anyone else or make your Account available to anyone
> else.

> You may not access or use, or help another person to access or use, our
> Services in the following ways: […] Except when you are accessing our
> Services via an Anthropic API Key or where we otherwise explicitly permit it,
> to access the Services through automated or non-human means, whether through a
> bot, script, or otherwise.

**OpenAI, [Terms of Use](https://openai.com/policies/terms-of-use/)
(effective 1 January 2026):**

> You may not share your account credentials or make your account available to
> anyone else and are responsible for all activities that occur under your
> account.

> What you cannot do. You may not use our Services for any illegal, harmful, or
> abusive activity. For example, you may not: […] Automatically or
> programmatically extract data or Output (defined below). […] Interfere with or
> disrupt our Services, including circumvent any rate limits or restrictions or
> bypass any protective measures or safety mitigations we put on our Services.

API keys are covered by each provider's business terms and usage policies:
Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
and [Usage Policy](https://www.anthropic.com/legal/aup), and OpenAI's
[Services Agreement](https://openai.com/policies/services-agreement/) and
[Usage Policies](https://openai.com/policies/usage-policies/).

### Example only: Claude Code subscription

> [!WARNING]
> **Example only.** This config shows the shape of the setting and nothing more.
> Anthropic's terms quoted above do not permit third-party tools to store or
> route requests through Claude plan credentials. Do not use it unless you have
> read those terms and accept the consequences.

[`example-only-claude-code-subscription.json`](examples/config/example-only-claude-code-subscription.json):

```json
{
  "providers": {
    "claude-code": { "enabled": true }
  }
}
```

### Example only: Codex subscription

> [!WARNING]
> **Example only.** This config shows the shape of the setting and nothing more.
> OpenAI's terms quoted above forbid making an account available to anyone else
> and circumventing rate limits. Do not use it unless you have read those terms
> and accept the consequences.

[`example-only-codex-subscription.json`](examples/config/example-only-codex-subscription.json):

```json
{
  "providers": {
    "codex": { "enabled": true }
  }
}
```

Both examples enable a single sign-in. Putting several sign-ins in one pool
with `team_routing.allowlisted_account_uuids` is the use the quoted terms most
clearly forbid.

## Advanced use

The server also exposes the routes directly:

- `http://localhost:8080/v1/<provider>/*`: one enabled provider, no pool.
- `http://localhost:8080/v1/pool/<protocol>/*`: a configured pool.

Run only the server with `agent-smith --serve`. Management writes need an
explicit `CF_ADMIN_KEY` sent as the `x-api-key` header. Read the
[configuration guide](docs/configuration.md) and the
[HTTP API reference](docs/api-http.md) before exposing anything beyond
localhost.

## Development

```bash
bun install
bun run tui          # Start the terminal screen from source
bun run server       # Start only the local proxy and dashboard
bun run verify       # Run tests, type checks, and linting
```

More detail lives in [docs/](docs/): [architecture](docs/architecture.md),
[configuration](docs/configuration.md), [provider behaviour](docs/providers.md)
and [load balancing](docs/load-balancing.md).

## Credits

agent-smith is a fork of [ccflare](https://github.com/snipeship/ccflare) by
snipeship. Routing behaviour is checked against
[TeamClaude](https://github.com/KarpelesLab/teamclaude) as reference data. Both
are MIT licensed.

## Disclaimer

agent-smith is an experimental proof of concept for ideation. It is not intended
for production use or for anyone else's accounts. It is not affiliated with,
endorsed by or sponsored by Anthropic or OpenAI. Claude, Claude Code, Codex,
ChatGPT and OpenAI are trademarks of their owners. Each provider's terms and
usage policies decide what you may do with your accounts, and checking them is
your job. The authors accept no liability for account actions, costs or other
consequences of running it.

## License

MIT, see [LICENSE](LICENSE). The software is provided "as is", without warranty
of any kind.
