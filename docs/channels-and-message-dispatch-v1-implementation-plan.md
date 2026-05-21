# Implementation plan: Channels and message dispatch v1

This document is the first implementation milestone for the broader channels/message-dispatch redesign described in `docs/channels-and-message-dispatch-implementation-plan.md`.

The broader plan remains the destination. This document narrows the first buildable slice so we can land the core model cleanly, verify it on both deployment targets, and then return to the deferred pieces with a much stronger foundation.

## 1. v1 scope

v1 delivers the new agent/message model end-to-end on **both Node and Cloudflare**:

1. **One agent module shape**
   - Agent modules export `init` and optionally `onMessage`.
   - Default-export request handlers are removed.
   - If `onMessage` is omitted, the runtime supplies a default that forwards `msg.content` to `agent.send(...)`.

2. **Dispatcher-owned delivery lifecycle**
   - One dispatcher per `(agentName, instanceId)`.
   - Lazy wake/init.
   - FIFO message admission.
   - Single-flight `onMessage` execution.
   - Bounded pending queues.
   - Clear init failure handling.

3. **`runtime.deliver(...)` as the canonical internal primitive**
   - Supports explicit delivery envelopes plus an ergonomic internal convenience overload.
   - Returns a `DeliveryHandle` with `messageId`, `events()`, and `waitForIdle()`.
   - Used by in-process callers and by channel adapters.

4. **HTTP channel only**
   - `channels = [http()]` mounts the public HTTP transport.
   - `POST /agents/:name/:id`
     - default JSON response waits for the queued message to finish and returns the JSON-serializable value from `onMessage(...)`
     - returns `204 No Content` when `onMessage(...)` returns `undefined`
     - SSE response when `Accept: text/event-stream`
   - JSON body parsing, metadata extraction, optional auth, queue-full `429`.

5. **Both runtime targets remain first-class**
   - Node runtime supports the dispatcher-backed flow.
   - Cloudflare runtime supports the same flow using the existing Durable Object architecture adapted to host dispatchers.
   - The milestone is not complete unless both targets pass equivalent behavior checks.

6. **CLI remains functional**
   - `flue run` continues to work for the new module shape.
   - Implementation choice should prefer the least disruptive path that preserves existing CLI behavior while routing work through the new dispatch semantics.

## 2. Explicitly deferred until after v1

These are intentionally **not** part of the first implementation pass:

- WebSocket channel.
- Cloudflare WebSocket hibernation behavior.
- Public instance-wide stream endpoint such as `GET /agents/:name/:id/stream`.
- Public event stream transform hooks.
- Multi-spawn wiring rules or recursive-spawn policy work.
- Social/webhook channels.
- Durable inbox / persisted pending message queue.
- Fire-and-ack `202 Accepted` JSON HTTP responses.
- Polling endpoints for completed messages.
- Broad event/store renaming beyond what is strictly required for the new dispatcher to work.
- `UserContent` widening beyond the current working content shape unless implementation pressure makes it unavoidable.

The broader plan can resume these once v1 is stable.

## 3. Product model for v1

### 3.1 Agent modules

```ts
import { defineAgent, http, type Agent, type AgentContext, type InboundMessage } from '@flue/runtime';

const support = defineAgent({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'You triage support requests.',
});

export const channels = [http()];

export async function init({ spawn }: AgentContext): Promise<Agent> {
  return spawn({ inherit: support });
}

export async function onMessage(agent: Agent, msg: InboundMessage): Promise<unknown | void> {
  agent.send(msg.content);
}
```

Rules:

- `init(ctx)` runs once per wake, not once per HTTP request.
- `onMessage(agent, msg)` runs once per delivered message.
- The dispatcher serializes `onMessage` per agent instance.
- `onMessage` may return JSON-serializable data for API/workflow-style agents.
- Omitted `onMessage` becomes the runtime default `agent.send(msg.content)`, which naturally returns `undefined`.

### 3.2 Delivery envelope

```ts
interface InboundMessage {
  messageId: string;
  content: string;
  channel: string;
  sender?: { id: string; name?: string; raw?: unknown };
  metadata: Record<string, unknown>;
  receivedAt: number;
}
```

For v1, `content` may remain string-shaped if that matches the current runtime and keeps the implementation smaller. The broader plan's `UserContent` widening is intentionally deferred unless the code change is trivially local and clearly lowers total churn.

### 3.3 Delivery API

```ts
interface DeliveryInput {
  content: string;
  metadata?: Record<string, unknown>;
  channel: string;
  sender?: { id: string; name?: string; raw?: unknown };
}

interface DeliveryHandle {
  readonly messageId: string;
  events(): EventStream;
  waitForIdle(): Promise<{ result?: unknown; error?: unknown }>;
}
```

The `result` here is the **delivery result**: the JSON-serializable value returned by `onMessage(...)`. It is distinct from prompt/tool operation results exposed elsewhere in the runtime.

Public runtime APIs:

```ts
deliver(agentName, instanceId, input: DeliveryInput)
deliver(agentName, instanceId, content: string, metadata?: Record<string, unknown>)
```

The convenience overload implies `channel: 'internal'`.

## 4. Completion and ordering semantics

To keep v1 understandable and safe, use the simpler rule:

> A message remains active until `onMessage` has returned and all work synchronously scheduled by that message through the current agent send path has completed.

Practical implications:

- The next `onMessage` should not begin while the previous message's direct agent-send work is still in flight.
- Per-message SSE closes only after that message is truly done.
- `waitForIdle()` resolves at the same point and exposes either the returned delivery `result` from `onMessage(...)` or an `error`.
- Plain JSON HTTP requests wait on that same completion boundary before producing their response.
- We avoid early interleaving between message N+1 and still-running model work from message N.
- A delivery owns each `agent.send(...)` call invoked while its `onMessage(...)` execution is still active. Sends initiated after `onMessage(...)` has settled are outside that delivery boundary.
- Multiple `agent.send(...)` calls issued by one `onMessage(...)` should queue in order rather than throw a busy error.
- Failures from queued `agent.send(...)` work count as delivery failures and surface through `waitForIdle()`, JSON HTTP errors, and SSE terminal error completion.

This is intentionally more conservative than the larger plan's split between `onMessage` serialization and later send completion tracking. Once the dispatcher is landed, we can revisit whether that extra concurrency is worth the complexity.

## 5. Target architecture

### 5.1 Dispatcher

Create a dispatcher abstraction shared by both targets. It owns:

- Agent module reference.
- Lifecycle state: `cold`, `initializing`, `ready`, `broken`.
- Cached live `Agent` returned by `init`.
- Pending inbound message queue.
- Per-message event routing.
- Delivery completion tracking.

Required properties:

- First cold delivery is accepted/materialized before init begins.
- Wake metadata is derived from that first accepted delivery.
- Init runs once for the warm dispatcher.
- Concurrent deliveries preserve FIFO acceptance order.
- Only one message lifecycle is actively processed at a time.
- Queue overflow fails explicitly.
- Init failure fails queued deliveries and supports a later retry/backoff strategy.

### 5.2 Node

Node should maintain a dispatcher registry keyed by `(agentName, instanceId)`.

- Creating the first delivery creates the dispatcher.
- Idle dispatchers may be evicted with a timeout if that behavior already fits the surrounding runtime cleanly.
- Do not block v1 on sophisticated idle management; correctness of the dispatcher path matters more.

### 5.3 Cloudflare

Cloudflare support is required in v1.

Preferred direction:

- Preserve the current build/runtime shape wherever practical.
- Adapt the existing Durable Object ownership model so each addressable agent instance routes into a dispatcher-backed execution path.
- Do not require the WebSocket hibernation redesign in this milestone.
- Do not change the Cloudflare architecture more than necessary to land dispatcher-backed HTTP delivery.

If the implementation reveals that a generic `(agentName, instanceId)` dispatcher DO is significantly cleaner than the current generated-per-agent DO layout, stop and reassess before doing the migration. That would be a design pivot, not an incidental refactor.

## 6. HTTP channel v1

### 6.1 Surface

```ts
export const channels = [http()];
```

The HTTP channel mounts the canonical route:

```txt
POST /agents/:name/:id
```

### 6.2 Body shape

Use the existing payload/message conventions as a migration bridge:

- Parse JSON body.
- If a top-level `message` field exists, it becomes `content`.
- Remaining fields become `metadata`.
- If no `message` exists, use `''` as content and preserve the rest as metadata.

### 6.3 Responses

- Default JSON response:
  - enqueue the message and wait for its completion
  - if `onMessage(...)` returns JSON-serializable data, return `200 OK` with that raw value as the JSON response body
  - if `onMessage(...)` returns `undefined`, return `204 No Content`
  - if processing fails, return the existing runtime error response shape consistently across targets
  - this intentionally replaces today's sync HTTP behavior where a response may return before detached agent work settles
- `Accept: text/event-stream`
  - stream the message's events
  - close when that message completes
  - the terminal completion event carries the same delivery result or delivery error exposed through `waitForIdle()`
- Queue full:
  - `429 Too Many Requests`
- Invalid JSON/body:
  - `400 Bad Request`
- Optional auth failure:
  - `401 Unauthorized`

### 6.4 Auth

```ts
interface HttpChannelOptions {
  auth?: (ctx: HttpAuthContext) => boolean | Promise<boolean>;
}
```

Auth runs after successful body parsing and before dispatch.

## 7. Build and loader implications

### 7.1 Agent module loading

The loader must expect:

- required `init`
- optional `onMessage`
- optional `channels`

It must reject modules with no `init` using a clear error.

### 7.2 Trigger replacement

The old `triggers` concept is retired by the direction of the larger plan, but v1 should not over-engineer build-time channel analysis.

For the first milestone, choose the lowest-churn viable strategy that allows:

- channel-aware HTTP exposure
- both Node and Cloudflare builds
- migration of example agents from `triggers` to `channels`

If the current build system depends on static `triggers` metadata for deployment scaffolding, treat that as a dedicated implementation decision early in the work rather than burying it inside the router migration.

## 8. CLI behavior

`flue run` must keep working against the new module shape.

Implementation guidance:

- Preserve current user-visible behavior where possible.
- Prefer reusing the existing invocation architecture if moving to direct in-process `runtime.deliver(...)` would create disproportionate churn.
- The key v1 requirement is semantic alignment: CLI-delivered work must pass through the new dispatcher/message model, not resurrect the old default-export request-handler model.

## 9. Implementation phases

### Phase 0 — Design checkpoints before code

Resolve and document the narrow implementation choices that affect architecture:

1. Cloudflare dispatcher fit:
   - **Decision:** adapt the current generated-per-agent DO structure and host the dispatcher inside each existing agent-instance DO.
2. Build-time channel exposure:
   - **Decision:** replace static `triggers.webhook` detection with minimal static detection of exported `channels = [http(...)]`, preserving as much existing downstream build plumbing as practical during v1.
3. CLI path:
   - **Decision:** keep the current server-mediated `flue run` flow and route it through dispatcher-backed HTTP/SSE rather than moving CLI to direct in-process delivery.

Checkpoint: these three choices are explicit before broad code changes begin.

### Phase 1 — Types and module contract

- Add `AgentContext` for module-level `init`.
- Add `InboundMessage`.
- Add `DeliveryInput`, `DeliveryHandle`, and `EventStream` types as needed.
- Add `Channel` / `ChannelContext` types sufficient for `http()` only.
- Add `http()` factory surface.
- Update exports.

Checkpoint: runtime typecheck passes.

### Phase 2 — Dispatcher core

- Implement dispatcher lifecycle and queue.
- Materialize first cold delivery before init.
- Add default `onMessage` fallback.
- Capture the return value from `onMessage(...)` so queued JSON HTTP callers and `waitForIdle()` can receive it.
- Implement completion semantics conservatively: next message waits for previous message completion.
- Implement `DeliveryHandle.events()` and `waitForIdle()`.
- Add bounded queue behavior and init failure behavior.

Checkpoint: focused dispatcher unit tests pass.

### Phase 3 — Node integration

- Add/get dispatcher registry for Node.
- Route internal `deliver(...)` calls through it.
- Wire node-side HTTP delivery path into dispatcher-backed behavior.

Checkpoint: Node runtime integration test delivers multiple messages FIFO and supports SSE completion.

### Phase 4 — Cloudflare integration

- Route Cloudflare HTTP agent delivery into dispatcher-backed behavior.
- Preserve the current DO architecture unless the Phase 0 decision explicitly chooses otherwise.
- Ensure Cloudflare runtime semantics match Node for init-once-per-wake, FIFO ordering, and completion.

Checkpoint: Cloudflare integration test covers POST JSON and POST SSE.

### Phase 5 — HTTP channel migration

- Implement `http()` Hono channel app.
- Mount it for agents that export `channels = [http()]`.
- Parse body, extract content/metadata, run auth, dispatch, return queued JSON result / `204` or SSE.
- Return 429 on queue overflow.

Checkpoint: same HTTP-facing behavior passes on both targets.

### Phase 6 — Module-loader and examples migration

- Remove old default-export handler path.
- Require `init` export.
- Substitute default `onMessage` when omitted.
- Migrate representative hello-world and Cloudflare examples.
- Replace old `triggers` use where needed for the v1 channel path.

Checkpoint: example agents run through `flue run` and HTTP/SSE on both targets.

### Phase 7 — CLI alignment

- Update `flue run` for the new module/message model.
- Preserve expected stderr/stdout streaming behavior as closely as practical.
- Ensure CLI never depends on the removed default-export handler contract.

Checkpoint: `flue run` works on migrated examples.

### Phase 8 — Documentation and changelog

- Update changelog.
- Update project docs/AGENTS terminology enough to match the implemented v1 model.
- Record deferred follow-up scope explicitly so later work resumes from the larger plan.

Checkpoint: no user-facing docs imply the old handler-per-request model remains current.

## 10. Required tests

At minimum:

### Dispatcher
- cold init happens once per warm dispatcher
- first accepted cold delivery owns wake metadata
- FIFO ordering across concurrent deliveries
- no overlapping active message lifecycles
- init failure fails queued deliveries
- queue overflow is explicit
- returned `onMessage(...)` values are preserved as delivery results
- `waitForIdle()` resolves at the same completion boundary as SSE close and carries the `onMessage(...)` result when present

### Module contract
- missing `init` throws clearly
- omitted `onMessage` uses default agent-send behavior
- `channels` omission produces an internally deliverable but not publicly mounted agent

### HTTP channel
- JSON POST waits for completion and returns the JSON-serializable `onMessage(...)` result with `200`
- JSON POST returns `204` when `onMessage(...)` returns `undefined`
- SSE POST streams and closes on completion
- malformed JSON returns 400
- auth sees parsed body and can reject with 401
- queue overflow returns 429
- content/metadata split behaves consistently

### Cross-target parity
- all core HTTP/dispatcher tests execute on Node and Cloudflare targets where applicable
- examples run in both target environments

### CLI
- migrated agent runs successfully
- CLI path exercises new message-dispatch semantics

## 11. Acceptance checklist

v1 is complete when:

1. Agent modules use `init` plus optional `onMessage`.
2. `onMessage(...)` may return JSON-serializable workflow/API results, or `undefined` for message-only agents.
3. Default-export request handlers are no longer the runtime execution path.
4. `runtime.deliver(...)` is the canonical internal delivery primitive.
5. A dispatcher serializes message lifecycles FIFO per `(agentName, instanceId)`.
6. Node and Cloudflare both pass the same core delivery semantics.
7. `http()` provides queued JSON result responses plus SSE delivery.
8. Queue overflow and auth/body failures are explicit.
9. `flue run` works with the new model.
10. Representative examples are migrated.
11. Docs/changelog describe the v1 model accurately.

## 12. Deferred next plan

After v1 lands, return to the broader implementation plan and continue with:

- WebSocket channel.
- Cloudflare WebSocket hibernation support.
- Public instance-wide subscriptions.
- Public stream transforms.
- Richer event naming/store cleanup if still desired.
- `UserContent` widening.
- Multi-spawn/recursive-spawn policy.
- Future social/webhook transport design.
