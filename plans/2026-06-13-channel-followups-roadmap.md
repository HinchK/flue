# Channel Follow-Ups Roadmap

## Status

The ten-provider first-party channel plan is implemented and audited. This
document records release work, deferred product decisions, and candidate
expansions without reopening the completed ingress design.

## Principles

- Preserve the current ownership boundary: Flue owns verified ingress,
  provider identity, protocol responses, and routing; applications own SDK
  clients, credentials, tools, and broad outbound behavior.
- Require Node and Cloudflare Workers execution for every canonical path.
- Add provider-specific behavior only when official protocol semantics justify
  it. Do not introduce a universal event schema, outbound client, or tool set.
- Treat long-lived sockets, OAuth installation systems, multi-tenant credential
  stores, and direct agent transports as separate product surfaces.
- Continue using primary provider sources and original synthetic fixtures.

## 1. Release The Completed Channels

This is the immediate next milestone.

- Choose the release version and publish the ten `@flue/*` channel packages
  together with the runtime and CLI changes they require.
- Deploy `apps/www` so the public connector registry serves all ten named
  recipes before announcing `flue add <provider>`.
- Publish the updated documentation and verify every public guide, API page,
  and connector markdown URL.
- Repeat the packed-artifact consumer check against the actual published
  versions.
- Run one credentialed smoke per provider in disposable test applications when
  practical. Keep these manual and provider-scoped rather than adding live
  credentials to CI.
- Resolve the existing Cloudflare example warning by documenting or generating
  the required Durable Object migration configuration before presenting the
  examples as deployment-ready.

Release exit criteria:

- every package is installable from the registry;
- every public `flue add` command returns the intended recipe;
- Node and Cloudflare examples build from published artifacts;
- no guide points at an unpublished package or undeployed connector.

## 2. Automate Channel Conformance

The final audit required several manual release checks that should become one
repeatable repository command.

- Add a channel conformance runner that discovers first-party channel packages
  and examples rather than maintaining another provider list.
- Cover package build, strict types, Node tests, workerd tests, Node example
  build, Cloudflare example build, and project-client fake-transport tests.
- Pack each package, inspect its allowlisted contents, install it into a clean
  strict consumer, and import its public entrypoint.
- Exercise each generated connector through a local registry and assert that
  the provider package and all published route suffixes are present.
- Add a generated or validated route catalog so shared docs cannot omit an
  implemented optional route such as Slack `/commands`.
- Keep provider protocol assertions in provider suites. The conformance runner
  should protect shared release contracts, not duplicate protocol tests.

## 3. Production Installation Patterns

Fixed-installation examples are appropriate for the first release. The next
cross-provider design problem is deployment-owned installation state.

- Write a focused plan for OAuth callbacks, credential encryption, token
  rotation, tenant or workspace lookup, webhook registration, and revocation.
- Determine which pieces are framework primitives versus documented
  application patterns. Avoid a universal provider credential schema.
- Design authorization guidance around conversation keys explicitly not being
  capabilities.
- Add durable idempotency examples that claim provider delivery ids before
  dispatch when duplicate admission is unacceptable.
- Consider an application-level error and telemetry hook for verified webhook
  failures before adding package-specific logging APIs.

Priority providers for installation guidance:

- Slack OAuth and multi-workspace apps;
- GitHub App installation tokens;
- Microsoft Teams multi-tenant bot registration;
- Linear OAuth organizations;
- Meta multi-WABA, multi-phone-number, and multi-Page deployments.

Public demand also calls out multi-tenant bot installations and automatic
webhook registration:
<https://github.com/vercel/chat/issues/563>.

## 4. Expand Existing Providers Only From Concrete Demand

Keep these additions in project-owned clients unless ingress normalization or
provider response semantics require package work.

- Slack: richer event families, attachment metadata, Socket Mode as a separate
  transport, and egress proxy guidance.
- Discord: Gateway transport, ordinary message events, channel-level message
  identity, and command registration guidance. Public demand:
  <https://github.com/vercel/chat/issues/178>.
- Teams: file-card and Graph resolution guidance, Adaptive Cards, proactive
  conversations, and federated workload identity.
- Google Chat: Workspace Events subscription lifecycle, cards, reactions, and
  user-authorized operations.
- Linear: broader issue and project events plus agent-activity policy examples.
- Telegram: additional Update families, typing and media examples, and polling
  as a separate transport.
- WhatsApp: templates, read receipts, media, Flows, and restored edit semantics
  when Meta documents a stable protocol.
- Twilio: keep Voice, Conversations, and Verify separate from Messaging.
- Messenger: Handover Protocol and marketing-message behavior only after a
  concrete application need.

## 5. Research New First-Party Channels

Each candidate starts with the same clean-room provider process and may be
deferred immediately if no defensible Workers path exists.

### Stripe

High priority because the channel API was originally shaped around Stripe's
verified event construction model and Stripe webhooks are common agent
triggers.

- Verify the current Stripe SDK's exact request-byte verification path in
  workerd.
- Support a fixed `/webhook` route with typed `Stripe.Event` delivery if the
  official SDK executes on both targets.
- Keep all Stripe API operations and tools project-owned through the exported
  SDK client.

### Inbound Email / Resend

High priority for support, sales, and operations agents. Vercel's public adapter
directory highlights inbound email through Resend as a useful platform class.

- Research Resend inbound email webhook verification, batching, attachment
  retrieval, retries, and canonical thread identity.
- Prefer the official Fetch-based client if it passes workerd.
- Treat outbound email composition and reply policy as project-owned behavior.

### Instagram Messaging

High priority adjacent to the completed Meta packages, but it must not be
silently folded into Messenger.

- Confirm current Instagram webhook fields, account identity, message and
  comment surfaces, signature behavior, and Graph API permissions.
- Reuse no Messenger normalization by default; share only small internal
  verification helpers if protocol equivalence is demonstrated.

### Additional candidates

- Shopify webhooks for commerce and support workflows.
- Intercom and Zendesk for customer-support event ingress.
- Notion and Jira for workspace automation where verified webhook coverage is
  stable and useful.

Demand signals should inform ordering, not API design. Current public Chat SDK
issues also show interest in generic HTTP adapters and Agent Client Protocol,
but those do not automatically belong in the first-party channel package set.

## 6. Keep These As Separate Product Decisions

### Generic HTTP or webhook adapter

Flue already supports `flue add <provider-docs-url> --category channel` and a
custom-channel guide. A generic package cannot safely supply provider
verification, identity, retry, or response semantics.

Improve the custom-channel recipe, reusable test fixtures, and conformance
helpers before considering a generic runtime abstraction. Public demand:
<https://github.com/vercel/chat/issues/96>.

### Agent Client Protocol

ACP may be a direct agent transport rather than a provider webhook channel.
Evaluate its routing, session identity, streaming, and authentication against
Flue's existing agent HTTP and WebSocket surfaces before assigning ownership.
Public request: <https://github.com/vercel/chat/issues/552>.

### Long-lived provider transports

Slack Socket Mode, Discord Gateway, and Telegram polling have process
lifecycle, reconnection, cursor, and deployment requirements unlike verified
HTTP ingress. Plan them together only if a shared transport lifecycle actually
emerges; do not force them through channel route declarations.

## 7. Deferred Provider Operations

The following remain application or deployment responsibilities until a
separate plan promotes them:

- app and bot creation, review, consent, and marketplace approval;
- webhook registration and subscription renewal;
- token generation, encryption, rotation, and revocation;
- multi-tenant installation lookup and authorization;
- broad outbound APIs, rich UI builders, uploads, history, and search;
- provider-backed deduplication and application delivery claims;
- credentialed end-to-end testing against real services.

## Suggested Sequence

1. Release and deploy the completed ten-provider work.
2. Add the automated conformance and artifact gate.
3. Plan installation state and idempotency patterns.
4. Research Stripe, inbound email/Resend, and Instagram Messaging one at a
   time, shipping only after Node and workerd execution is proven.
5. Reassess provider expansions from user demand after the first channel
   release has real adoption data.

No additional channel was added during the final audit. Starting another
provider after the completed cross-provider review would require a fresh
research, implementation, testing, and audit cycle; the candidates above are
better handled as independent workstreams.
