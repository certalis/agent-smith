# Provider routing boundaries

## Intent

Keep the interactive Claude-compatible provider chooser working exactly as it
does now, while separating its policy from account state, credentials, and
provider-specific parsing. Agent-smith remains one deployable proxy.

## Boundaries

- `routing` owns configured-order choice, durable provider preference,
  promotion refusal, and the private chooser protocol. It accepts an opaque
  state store and capacity facts; it never imports database or provider code.
- `capacity` owns the small, provider-neutral block vocabulary and availability
  facts. It has no account, credential, or HTTP-provider dependency.
- `pool` implements routing's opaque state store with the existing database
  facade and continues to own account choice, team access, pins, leases, and
  quota facts.
- `connectors` remain in `providers`: they own native authentication,
  execution hooks, and Model Studio rate-limit parsing. They emit `capacity`
  facts rather than routing decisions.
- `adapters` is reserved for the next slice: Anthropic canonical protocol to
  Google/OpenAI/provider wires. No adapter reaches account storage directly.
- `client-companion` remains a Claude plugin that transports versioned headers,
  renders UI, and shows status. It does not decide eligibility or fallback.

## Dependency rule

The request path is companion → routing → capacity source → pool/connector.
The concrete pool implements routing's store/source interfaces, so the import
direction stays inward: routing depends only on its own interfaces and
`capacity`; pool and connectors depend on the interfaces they implement.

## Non-goals

- No Google/OpenAI payload translation in this change.
- No change to configured ordering, pinning, wait limits, or no-auto-switch
  behavior.
- No database migration or credential format change.
- No new process or deployment unit.

## Proof

Tests keep the chooser's observable behavior, verify the routing package can
be exercised with an in-memory state store, and verify the pool implementation
persists through the existing database facade. A local smoke server uses the
fake upstream only; no real provider credential is used.
