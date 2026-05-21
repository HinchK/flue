# Implementation plan: Channels, message dispatch, and the unified agent model

This document is the implementation plan for Flue's next major API shift. It supersedes the previous plan at `~/Documents/agent-init-and-send-implementation-plan.md` (the `init() → Agent` / `agent.send()` work) by carrying forward what was sound and replacing what wasn't.

The change has three parts that hang together:

1. **One agent shape.** Every Flue module is an agent. The "workflow vs agent" distinction is retired. The module exports `init` and `onMessage`. An agent that does 30 minutes of deterministic work and exits is just an agent whose `onMessage` does 30 minutes of work; an agent that chats interactively is just an agent whose `onMessage` is fast. There is no separate "workflow" module shape.
2. **Channels replace triggers.** Transport is abstracted behind a `Channel` concept. v1 ships HTTP/SSE and WebSocket channels as bidirectional transport adapters: inbound delivery plus outbound runtime-event streaming to the connected caller. Future webhook/social channels remain deferred. Each channel is a Hono app the framework mounts under the agent's URL namespace. The framework's prior `triggers` concept is replaced.
3. **`runtime.deliver` is the universal in-process delivery primitive.** Channels translate external transport events into a call to `runtime.deliver(name, id, { content, metadata, channel, sender })`. The public top-level convenience overload `runtime.deliver(name, id, content, metadata?)` remains ergonomic for CLI / SDK-in-process / local delegation and defaults `channel` to `'internal'`. The dispatcher behind both forms owns init, FIFO ordering, completion tracking, and event fan-out.

This plan is intended to be sufficient for an implementer (likely an agent) to execute end-to-end without needing the design conversation that produced it. It captures the settled model, the API surface, the runtime mechanics, the implementation sequencing, the migration story, and — importantly — design rationale, so an implementer hitting an unforeseen edge case can resolve it in keeping with the framework's intent.

---

## 1. Context and motivation

### 1.1 What the previous plan got right

The plan that this one supersedes (`agent-init-and-send-implementation-plan.md`) made three correct calls we are keeping:

- `init()` returning a live `Agent` rather than a `FlueHarness`. The URL is the agent; the return type should reflect that.
- `agent.send()` as a fire-and-forget delivery primitive that hides turn-lifecycle from the developer.
- `defineAgent()` + `inherit` as the canonical pattern for lifting an agent's identity (model, instructions, skills, tools, subagents) to module scope.
- Persistent virtual workspace keyed by `[instanceId, harnessName]`, `ctx.register()` for one-time-per-instance setup. (These are unchanged from approach 2 and from the previous plan.)

### 1.2 What the previous plan got wrong, and why

The previous plan kept the **default-export handler** as the per-request entry point. Every inbound HTTP POST re-ran the handler, which constructed the agent and called `agent.send`. That model has four serious problems:

**P1 — Out-of-order delivery.** Two POSTs arrive concurrently. Handler 1 hits an `await` before reaching `agent.send`; handler 2 races ahead. The user's typed order is lost. The previous plan's "reject second concurrent POST with 409" hides this but doesn't solve it, and becomes a bug as soon as we soften reject into queue.

**P2 — Wrong mental model.** Users think "I'm sending a message to an agent." The previous shape says "every message re-runs the boot sequence and then sends." The handler also owned *constructing* the message from the raw payload, so the framework couldn't reason about messages as a primitive — they were just whatever the user code happened to build.

**P3 — Per-message overhead.** Re-running init logic on every message (skill discovery, system prompt assembly, workspace attach, auth checks) is expensive work the runtime repeats for no reason.

**P4 — No clean WebSocket story.** A WebSocket is one connection, many messages. There is no natural place for "run the handler per message" in that model. We have an external Cloudflare team blocked on WebSocket support; we can't ship it under the previous shape without forcing handler-per-frame, which is the wrong abstraction.

**P5 — No place for richer transports.** WebSockets and future webhook/social integrations need a clean way to deliver inbound events without reviving "POST a payload, default handler runs." The previous shape has no answer for these.

### 1.3 The settled mental model

The agent is a long-lived addressable entity, identified by `(agentName, instanceId)`. It wakes when something delivers a message to it. It hibernates when it's idle. When it wakes, `init` runs once to spin it up; thereafter, `onMessage` runs for each message in FIFO order. Channels translate external transport events into calls to the delivery primitive with channel identity and sender context; HTTP/SSE and WebSocket also stream runtime events back to their connected callers.

> **`init` spins up the agent. `onMessage` handles a message. Channels deliver messages. The agent itself is the addressable thing.**

This pedagogical claim is the reason the module shape is uniform: a "workflow" is just an agent whose `onMessage` does the workflow's work. There is no separate concept.

### 1.4 What this is and is not

**This is:**
- A redesign of the inbound-message dispatch path.
- A redesign of transport handling (channels replace triggers).
- A unification of the "agent" and "workflow" concepts into a single module shape.
- An introduction of `runtime.deliver` as the framework's universal in-process delivery primitive.
- The introduction of Hono apps as the channel surface, giving channel authors full Hono expressiveness.

**This is not:**
- A redesign of `defineAgent`, `AgentDefinition`, `inherit`, sessions, the harness, or pi-agent-core integration. Those stay as the previous plan landed them.
- A redesign of session/workspace persistence. That stays as approach 2 landed it.
- Durable autonomous execution. Agents still don't tick or wake on their own; they wake when something delivers a message.
- Cross-channel hand-off or channel-managed platform reply orchestration. Out of scope; developers decide how to respond using SDKs, fetch clients, or future higher-level integrations.
- Channel-level message editing, typing indicators, thread replies, or social-posting APIs. HTTP/SSE and WebSocket only stream Flue runtime events back to the connected caller.
- Type-safe channel-specific metadata. `msg.metadata` is `Record<string, unknown>` in v1.
- Built-in social or webhook channels. This plan keeps room for them, but does not implement them.

---

## 2. Settled product model

### 2.1 The agent module

Every agent module exports `init` and `onMessage`. It may export `channels`. Nothing else is required.

```ts
import { defineAgent, http, websocket, type AgentContext, type InboundMessage, type Agent } from '@flue/runtime';
import { triageSkill } from '../skills/triage.ts';

const support = defineAgent({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'You triage GitHub issues.',
  skills: [triageSkill],
});

export const channels = [http(), websocket()];

export async function init({ spawn, register }: AgentContext): Promise<Agent> {
  const agent = await spawn({ inherit: support });

  await register(async () => {
    await agent.harness().fs.writeFile('context.md', 'first-run seed');
  });

  return agent;
}

export async function onMessage(agent: Agent, msg: InboundMessage): Promise<void> {
  agent.send(msg.content);
}
```

**`init({ spawn, register, ... })`** runs once per agent wake. It spins up the agent — sandbox, harness, identity (via `spawn(...)` which replaces the previous plan's in-handler `init(...)` factory), and any per-wake side effects. It returns the live `Agent`. The dispatcher caches this `Agent` for the duration of the wake; subsequent messages reuse it. By convention, agent modules destructure the context at the function signature (`{ spawn, register, env, id, metadata }`) rather than holding a `ctx` object — match the existing codebase style.

**`metadata` on `AgentContext`** is the channel-provided context from the message that woke this agent. It's `Record<string, unknown>` — the channel populates it during inbound translation; the framework does not type or validate it. Use it to do per-user / per-context setup inside `init` (e.g., loading the user's sandbox). See §4.4 for the semantics of cached-from-wake `metadata` (on `init`) vs current-message `msg.metadata` (on `onMessage`).

**`onMessage(agent, msg)`** runs once per message, serialized per `(agentName, instanceId)`. May be sync or async. The framework awaits the returned promise before dispatching the next message. The default implementation, used if the developer omits this export, is `(agent, msg) => agent.send(msg.content)`.

**`channels`** is an array of `Channel` values. If omitted, only the internal channel is mounted — the agent is only addressable via CLI / SDK-in-process / subagent calls.

### 2.2 `spawn` and the definition surface

The previous plan called this `init({ inherit, sandbox, ... })` and ran it inside the default-export handler. In this plan, `init` is now a module-level export, so the in-handler factory is renamed to `spawn`. The verb fits the noun (you're spawning an agent value from a definition) and supports the multi-spawn case (see below).

```ts
interface AgentContext {
  readonly id: string;                            // instance id from URL / continuation token
  readonly env: Env;
  readonly log: FlueLogger;
  readonly metadata: Record<string, unknown>;     // from the message that woke this agent — cached for the wake
  spawn(options: SpawnOptions): Promise<Agent>;
  register(fn: () => Promise<void>): Promise<void>;
}

interface SpawnOptions {
  inherit?: AgentDefinition;
  model?: ModelConfig;
  instructions?: string;
  skills?: Skill[];
  tools?: ToolDef[];
  subagents?: AgentDefinition[];
  thinkingLevel?: ThinkingLevel;
  compaction?: false | CompactionConfig;
  name?: string;             // harness name; defaults to "default"
  cwd?: string;
  sandbox?: false | SandboxFactory | BashFactory;
  persist?: SessionStore;
}
```

Merge semantics from the previous plan are unchanged: when `inherit` is present, init-level fields fully replace the corresponding field on the inherited definition. Lists do not auto-append.

**`spawn` may be called multiple times.** A single `init` may spawn several agents — typically one primary (returned from `init`, becomes the addressable agent for `onMessage`) and zero or more secondaries that the primary uses as tools or delegates to:

```ts
export async function init({ spawn }: AgentContext): Promise<Agent> {
  const triage   = await spawn({ inherit: triageDef });
  const research = await spawn({ inherit: researchDef });   // secondary
  const writer   = await spawn({ inherit: writerDef });     // secondary
  // wire research and writer in as tools/subagents of triage (mechanism TBD)
  return triage;
}
```

The exact mechanism for wiring secondaries into the primary (as tools, as delegates, etc.) is not specified in this plan — that's a future-design concern. What matters here: **the API does not assume one spawn per init.** Multi-spawn is a first-class shape. Concrete guardrail for v1: spawned secondary/subagent definitions do **not** automatically inherit permission or capability to spawn recursively. Recursive spawning requires a future explicit opt-in design; avoid unbounded spawn chains by default.

By convention, callers destructure `init`'s context argument at the function signature rather than holding a `ctx` reference. This matches the codebase's existing style:

```ts
export async function init({ spawn, register, env, id }: AgentContext) { ... }
```

Holding `ctx` and writing `ctx.spawn(...)` works too, but the destructured form is what examples and docs should use.

### 2.3 The `Agent` value

```ts
interface Agent {
  readonly name: string;
  readonly id: string;
  send(content: UserContent, options?: SendOptions): void;
  harness(): FlueHarness;
}

interface SendOptions {
  session?: string;
}

// pi-ai's shape
type UserContent = string | (TextContent | ImageContent)[];
```

`send` is fire-and-forget. It accepts `UserContent` (pi-ai's shape), not just `string`. This is a widening from the previous plan, which only accepted `string`. The widening enables image/file inputs without further API work; it costs nothing because pi-agent-core already accepts `UserContent`.

`send` returns `void`. It does **not** throw on concurrent send; concurrent sends queue at the agent's internal scheduler level (see §3.5). This is a divergence from the previous plan, which threw `AgentBusyError` on concurrent send. We are removing that throw because the dispatcher now serializes `onMessage` (so at the `onMessage` boundary there is naturally one send at a time), and because per-agent message buffering is the canonical chat-agent behavior.

`harness()` returns the underlying `FlueHarness` for workflow-style code that wants direct control. Unchanged from the previous plan.

### 2.4 The `InboundMessage` envelope

```ts
interface InboundMessage {
  messageId: string;
  content: UserContent;                  // pi-ai's shape
  channel: string;                       // 'http' | 'websocket' | 'slack' | 'internal' | ...
  sender?: { id: string; name?: string; raw?: unknown };
  metadata: Record<string, unknown>;     // free-form; channel-populated; opaque to framework
  receivedAt: number;
}
```

`content` is what gets fed to the model when the agent's default `onMessage` calls `agent.send(msg.content)`. `metadata` is what the channel wants to expose to developer code without putting it on the model's context. The framework does not type or validate `metadata`; channels populate whatever shape they want.

`InboundMessage` is the framework's envelope. It is distinct from pi-ai's `UserMessage` (which has a `role`, `content`, `timestamp` shape). We do not reuse `UserMessage` as the envelope because we need framework metadata (channel, sender, messageId) that doesn't belong on a model-facing message.

### 2.5 Channels

A channel is a value produced by a factory function. The value carries metadata and a Hono-app builder:

```ts
interface Channel {
  readonly name: string;                 // 'http', 'websocket', 'internal', future third-party names
  readonly mount: 'top' | 'namespaced';  // only 'http' uses 'top'; everyone else namespaces
  app(ctx: ChannelContext): Hono;        // returns a Hono app to mount
}

interface DeliveryInput {
  content: UserContent;
  metadata?: Record<string, unknown>;
  channel: string;
  sender?: { id: string; name?: string; raw?: unknown };
}

interface ChannelContext {
  readonly agentName: string;
  readonly env: Env;
  deliver(instanceId: string, input: DeliveryInput): Promise<DeliveryHandle>;
  subscribe(instanceId: string): EventStream;
}
```

A channel **is a Hono app.** It is mounted at `/agents/:name` (top) or `/agents/:name/<channelName>` (namespaced). The channel's app builder receives a `ChannelContext` with a `deliver` function — that's how messages flow from transport-land into the framework. Built-in channels must pass their channel identity in `DeliveryInput.channel`; custom channels do the same. That input is the unambiguous source for `InboundMessage.channel` and `InboundMessage.sender`.

**Why Hono apps and not a higher-level routing DSL.** This codebase already uses Hono internally. Hono has a documented `mount()` API for mounting sub-apps under a parent app. Channels are sub-apps. By making the surface "return a Hono," channel authors get middleware, route grouping, parameter parsing, request validation, error handling — the entire Hono ecosystem — without us reinventing it. We considered an Ash-style `defineChannel({ routes: [POST(...), GET(...)] })` shape; we rejected it because it forces channels to use a parallel routing DSL and bakes HTTP-shaped assumptions into channels (e.g., a WebSocket channel having `routes: [POST(...)]` is incoherent). The Hono-app contract is more general and lower-friction.

**Why not an even smaller contract.** We considered "channels expose just an inbound handler, framework owns routing." We rejected that because future multi-route inbound channels may need to expose several URLs with different bodies and verbs, and we don't want the framework to grow a separate route-declaration mini-DSL inside channel configs.

#### 2.5.1 Channel option conventions

v1 keeps the channel contract intentionally small:

- `http()` accepts optional Hono middleware so request-specific concerns stay in the HTTP transport layer without inventing a parallel abstraction. Auth, tenant lookup, header/IP inspection, and request-scoped metadata enrichment should use the same middleware model channel authors already know from Hono.
- `websocket()` may expose channel-specific handshake auth while its route surface matures separately.
- Both built-in channels accept an optional synchronous `stream` transform for public outbound runtime-event frames.
- Both built-in channels derive `instanceId` from their URL path.
- Future webhook/social channels may need dedicated instance-id derivation, signature verification, or richer inbound parsing, but those APIs are deliberately deferred until we design those channels directly.
- Channels do not reply, post, edit, or manage platform-specific response state. HTTP/SSE and WebSocket are bidirectional transport adapters only where their transport calls for Flue-managed event streaming.

**Inbound translation is channel-internal, not a config field.** Each channel converts its native inbound shape into the universal `InboundMessage` shape that `runtime.deliver` consumes. v1 only needs this for HTTP bodies and WebSocket frames. Future third-party channels should follow the same rule unless a real extension hook proves necessary.

### 2.6 URL layout

```
/agents/:name/...                                   ← framework router; mounts each channel
   :name/:id                                        ← HTTP channel (top slot)
   :name/:id/stream                                 ← reserved; HTTP/SSE event stream
   :name/:id/messages                               ← reserved; future message history
   :name/<channelName>/...                          ← any other channel
        e.g. :name/websocket/:id                     ← (the WS channel chooses this layout)
        e.g. :name/<future-channel>/...              ← future third-party channels


```

**Reserved names at `/agents/:name/...`:** `stream`, `messages`, `internal`, `admin`. Channels cannot register a channel with one of these as its `name`. If they try, the framework throws at app construction time with a clear message. Reserved names do not require an underscore prefix; we just claim them. To avoid top-slot collisions, the HTTP channel also rejects these exact values as `:id`; `/agents/:name/stream`, `/messages`, `/internal`, and `/admin` are never interpreted as instance ids. The framework either handles reserved paths itself or returns 404.

**The HTTP channel's "top slot."** The HTTP channel is unique: it owns `/agents/:name/:id` (no channel-name segment). It does this because POSTing to `/agents/:name/:id` is the canonical, friction-free way to address an agent instance over HTTP, and we want that ergonomic URL preserved. Only one channel can have `mount: 'top'`; the framework enforces this at startup. By convention, only the built-in HTTP channel uses it; if a third party wants the top slot they have to displace the built-in HTTP channel.

**Channel name collisions.** If two channels in the same `channels` array have the same `name`, the framework throws at app construction with a clear error. Channel names should naturally be unique in practice (`http`, `websocket`, `slack` are distinct concepts); we error loudly rather than try to silently disambiguate.

**Instance-id resolution.** The framework does **not** prescribe how a channel derives `instanceId`. The HTTP channel reads it from a URL parameter. The WebSocket channel reads it from the upgrade URL. Future webhook/social channels can derive it from their native event payloads. By the time the channel calls `deliver(instanceId, ...)`, it has the id. The framework does not care how the channel got it.

### 2.7 `runtime.deliver` — the in-process primitive

```ts
function deliver(
  agentName: string,
  instanceId: string,
  input: DeliveryInput,
): Promise<DeliveryHandle>;

function deliver(
  agentName: string,
  instanceId: string,
  content: UserContent,
  metadata?: Record<string, unknown>,
): Promise<DeliveryHandle>; // convenience overload; channel defaults to 'internal'

interface DeliveryHandle {
  readonly messageId: string;
  events(): EventStream;
  waitForIdle(): Promise<{ error?: unknown }>;
}

function subscribe(agentName: string, instanceId: string): EventStream;
```

`deliver` is the universal in-process delivery primitive. Channels call the `DeliveryInput` form so construction of `InboundMessage` is fully specified. `flue run`, in-process `@flue/sdk`, and future local agent-to-agent delegation may use the ergonomic content/metadata overload, which is equivalent to `{ content, metadata, channel: 'internal' }`.

`deliver` returns synchronously (well, returns a `Promise` synchronously) with a `DeliveryHandle`. The handle gives callers two things they may want:

- `events()` — an EventStream filtered to events generated by this message's processing. The HTTP channel in SSE mode reads this through its public stream wrapper. The CLI consumes it raw.
- `waitForIdle()` — resolves with `{ error? }` when this message completes. A message completes exactly when its `onMessage` has returned **and** every `agent.send()` operation enqueued during that `onMessage` has finished. The CLI uses this to know when to exit. Future HTTP "wait for completion" modes would use this same definition.

`subscribe` returns an EventStream for **all** events at the instance — used by long-lived streaming transports such as WebSocket connections, and by any future observer surface that needs instance-wide events.

**Why a handle rather than `void`.** Different callers need different completion signals. HTTP/SSE wants per-message events. CLI wants per-message events plus an idle signal. WS wants instance-wide events for the connection lifetime. The handle exposes what's needed without inventing channel-managed reply semantics.

**What `events()` and `subscribe` actually return.** An `EventStream` is an `AsyncIterable<FlueEvent>` + a consumer-facing `cancel()` method. Implementation can reuse or generalize the existing `run-subscribers.ts` machinery. Events are tagged with their `messageId` when they originate from a specific message's processing; events that are instance-level (e.g., `agent_wake`, `agent_idle`) have no `messageId`.

### 2.8 Lifecycle

**Agent wake (per instance, lazy):**

1. First `deliver(name, id, ...)` arrives. Framework looks up `(name, id)` in the dispatcher registry.
2. If absent, framework creates a new dispatcher for this `(name, id)` and accepts/materializes that first delivery as an `InboundMessage` before init starts.
3. The first accepted cold delivery wins wake metadata: `AgentContext.metadata` is copied from that message. Concurrent cold deliveries enqueue after it in acceptance order and do not change init metadata.
4. The dispatcher loads the module, gathers the `init` and `onMessage` exports, enters the "initializing" state, and calls `init(ctx)`.
5. When `init` resolves, the dispatcher caches the returned `Agent`, transitions to "ready," and begins dispatching enqueued messages.

**Per-message (FIFO, single-flight `onMessage`):**

1. `deliver` is called with either explicit `DeliveryInput` or the internal convenience overload.
2. The framework generates a `messageId`.
3. The framework constructs `InboundMessage` from `{ content, metadata, channel, sender }`.
4. The framework enqueues into the dispatcher's queue, subject to bounded queue admission.
5. When the dispatcher is free (no `onMessage` running), it pulls the next message and calls `onMessage(agent, msg)`.
6. The dispatcher awaits the returned promise (or treats sync returns as already-resolved).
7. The dispatcher may pull the next message immediately, but the prior message is not complete until all `agent.send()` operations enqueued during that `onMessage` have finished.

**Completion definition:** a message completes exactly when `onMessage` has returned **and** every `agent.send()` operation enqueued during that `onMessage` has finished. `message_end`, per-message SSE stream closure, and `DeliveryHandle.waitForIdle()` all use this same definition. Dispatch serialization is narrower: the next `onMessage` may begin once the previous `onMessage` returns, even if completion waits on queued send work.

**Agent hibernate:**

- **Cloudflare:** The DO hosts the dispatcher. DO eviction is opaque (Cloudflare-driven). When evicted, the dispatcher and its cached `Agent` are dropped. Next `deliver` re-wakes via DO instantiation, which re-runs `init`.
- **Node:** The Node runtime maintains a per-`(name, id)` dispatcher registry. Idle timeout (configurable; default 5 minutes) drops entries from the registry. Next `deliver` after eviction re-wakes via fresh dispatcher creation, which re-runs `init`.

**Init failure:**

- All currently-enqueued messages fail with a clear error envelope (`{ error: 'agent init failed: <message>' }`) propagated to their `DeliveryHandle.events()` and `waitForIdle()` result.
- The dispatcher enters a "broken" state for a short backoff window (default 5 seconds — implementer's call, document the choice).
- During the backoff, new `deliver` calls fail immediately with the same error.
- After the backoff, the next `deliver` re-attempts init.
- Rationale: prevents thundering-herd retries on structurally broken init; gives the developer log signal quickly.

### 2.9 The internal channel

Every agent has an implicit internal channel. It is not removable. It has `name: 'internal'`, is not mounted in Hono at all (it has no transport-facing routes), and exists solely to make `deliver` available to in-process callers:

- `flue run` calls `runtime.deliver(name, id, content)` directly.
- `@flue/sdk` used in-process (same Node process as the runtime, e.g., in a unit test) calls `runtime.deliver` directly.
- Agents calling other local agents (future) use the same primitive.

The internal channel exists for documentation and conceptual clarity. Implementation-wise, "internal channel" may not be a `Channel` value at all — the runtime just exposes `deliver` and `subscribe` as APIs alongside the channel-mounting machinery.

The CLI question ("is `flue run` a channel?") is settled here: **`flue run` does not go through any channel.** It calls `runtime.deliver` directly. This is what enables `flue run` to work regardless of which channels are configured on the agent (including agents with no channels declared).

### 2.10 What's removed

- The `triggers` field on agent modules (e.g., `export const triggers = { webhook: true }`).
- The "default export = handler" path that consumed `payload` and returned a `result`. Agent modules export `init`/`onMessage` instead. Existing default-export modules need to migrate (see §7).
- The previous plan's `AgentBusyError` and the synchronous "throw on concurrent send" behavior. Concurrent `send` is allowed; per-agent buffering is the canonical chat-agent behavior. The implementer must not introduce a "busy" error in v1.
- The previous plan's idea of `init(...)` as the in-handler factory. Renamed to `spawn(...)` because `init` is now a module-level export, and because `spawn` correctly conveys "bring an agent value into being" (and supports being called multiple times in one `init` for primary + secondary agents).

### 2.11 Not removed, still in scope

- `defineAgent`, `AgentDefinition`, `inherit` semantics. Carry forward from the previous plan unchanged.
- `ctx.register(fn)` for one-time-per-instance setup. Carries forward.
- Persistent virtual workspace keyed by `[instanceId, harnessName]`. Carries forward.
- The serialized instance lane (one in-flight run per instance). **Updated:** lanes still serialize, but the unit being serialized is now `onMessage` invocations, not whole runs. The lane is owned by the dispatcher.
- All session/harness/skill machinery. Unchanged.

---

## 3. Runtime mechanics

### 3.1 The dispatcher

The dispatcher is the framework-owned object per `(agentName, instanceId)` that:

1. Holds the cached `Agent` returned by `init`.
2. Holds the message queue.
3. Owns the init lifecycle (state machine: `cold` → `initializing` → `ready` | `broken`).
4. Calls `onMessage` for each queued message, awaiting the return.
5. Routes events to per-message `EventStream`s and the instance-wide subscriber set.
6. Holds the idle timer (Node only).

**Location:**
- **Cloudflare:** the dispatcher is per Durable Object addressed by the composite `(agentName, instanceId)` identity. DO lookup/keying must preserve both parts; do not treat the raw agent instance id alone as globally sufficient. The DO `fetch`, RPC, and WebSocket handlers route into that dispatcher.
- **Node:** the dispatcher lives in a `Map<string, Dispatcher>` keyed by `agentName:instanceId` in the runtime process. Idle timer evicts entries.

**State machine:**

```
cold ────deliver()──→ initializing ────init resolves──→ ready
                                  │
                                  └── init throws ──→ broken (backoff)
                                                              │
                                                              └── backoff expires + deliver() ──→ initializing (retry)

ready ────deliver()──→ ready (enqueues; pulls when free)
ready ────idle timeout (Node) / DO eviction (CF)──→ <dispatcher dropped>
```

### 3.2 The dispatch loop

In pseudo-code (reference implementation; the actual code may differ in shape):

```ts
class Dispatcher {
  private queue: InboundMessage[] = [];
  private busy = false;          // is an onMessage currently running?
  private state: 'cold' | 'initializing' | 'ready' | 'broken' = 'cold';
  private agent?: Agent;
  private brokenUntil?: number;

  async deliver(input: DeliveryInput): Promise<DeliveryHandle> {
    if (this.state === 'broken' && Date.now() < this.brokenUntil!) {
      return makeRejectedHandle(/* with the cached init error */);
    }
    if (this.queueIsFull()) {
      throw new QueueFullError('dispatcher pending message queue is full');
    }
    const msg = this.makeInboundMessage(input);
    const handle = this.makeHandle(msg.messageId);
    this.queue.push(msg);
    if (this.state === 'cold' || (this.state === 'broken' && Date.now() >= this.brokenUntil!)) {
      this.context.metadata = msg.metadata; // first accepted cold delivery wins wake metadata
      this.state = 'initializing';
      this.initAttempt(); // fire-and-forget; populates this.agent or sets broken
    }
    this.maybeDispatch();
    return handle;
  }

  private async maybeDispatch() {
    if (this.busy || this.state !== 'ready' || this.queue.length === 0) return;
    this.busy = true;
    const msg = this.queue.shift()!;
    try {
      await this.module.onMessage(this.agent!, msg);
    } catch (err) {
      // Surface on the message's handle; do not crash the dispatcher.
      this.emitMessageError(msg.messageId, err);
    } finally {
      this.busy = false;
      this.maybeDispatch();
    }
  }

  private async initAttempt() {
    try {
      this.agent = await this.module.init(this.context);
      this.state = 'ready';
      this.maybeDispatch();
    } catch (err) {
      // Fail all enqueued messages with the init error.
      for (const msg of this.queue) this.emitMessageError(msg.messageId, err);
      this.queue = [];
      this.state = 'broken';
      this.brokenUntil = Date.now() + INIT_BACKOFF_MS;
    }
  }
}
```

**Key properties this captures (which the implementer must preserve):**

- Single-flight `onMessage` per dispatcher. Two messages do not run their `onMessage` concurrently.
- FIFO order. The queue is shifted, never reordered.
- Init failure does not destroy the dispatcher. The dispatcher transitions to `broken` and the same instance can recover on a later attempt.
- `agent.send`-triggered work is **not** awaited by the dispatch loop. The loop awaits `onMessage`'s promise only, while completion tracking separately waits for the sends enqueued during that invocation.

### 3.3 Per-instance serialization (the lane)

The previous plan introduced an instance run lane. We are keeping the spirit but redefining the unit:

- **Previous:** lane serialized whole "runs" (one POST = one run = one lane acquisition).
- **This plan:** lane serializes `onMessage` invocations within an agent. The dispatcher's `busy` flag is the lane.

We no longer reject ordinary concurrent inbound requests at the lane boundary. Instead, we enqueue them and process FIFO. The "second concurrent POST returns 409" behavior of the previous plan is gone. Admission is still bounded: dispatcher pending-message queues are configurable and finite; once full, new delivery is rejected with a queue-full error.

**For the implementer:** the existing `instance-admission.ts` on both Node and Cloudflare needs to either be deleted or repurposed. The new contract is "queue up to configured capacity, then reject explicitly." HTTP maps queue-full delivery rejection to 429; WS emits an error frame for that inbound frame; CLI/raw `deliver` surfaces the rejection.

### 3.4 Event emission and subscription

Today, events flow through `ctx.emitEvent(...)` → run subscribers + run store. With the dispatcher owning the event flow, the model shifts to:

- Events carry an optional `messageId` tag. Events emitted during a specific `onMessage` invocation (including all `agent.send`-triggered work attributable to that `onMessage`) carry that message's `messageId`.
- Two subscription endpoints:
  - **Per-message:** `DeliveryHandle.events()` — returns an EventStream filtered to events with the matching `messageId`.
  - **Per-instance:** `runtime.subscribe(name, id)` — returns an EventStream of all events.

**How to tag events with `messageId`:** the dispatcher establishes a logical "current message" context only while invoking `onMessage`. AsyncLocalStorage on Node or equivalent DO-local invocation state on Cloudflare is used solely to annotate the enqueue point. Each `agent.send()` operation captures `originMessageId` at enqueue time. Downstream events emitted by that queued operation read attribution from the operation itself, never from ambient current-message state after enqueue.

**Events emitted by `agent.send`-triggered work after `onMessage` returns:** if an enqueued send runs after `onMessage` resolves, its events still carry that send operation's captured `originMessageId`. This is a small but important detail; without it, per-message event streams and completion accounting would cut off at the wrong point.

**Run-end semantics:** the previous plan emitted `run_start`/`run_end` events per POST. We retire these as instance-level events. Per-message, we emit `message_start` / `message_end` events (carrying messageId). Per-instance, we emit `agent_wake` / `agent_idle` events (no messageId).

**Public stream shaping.** HTTP/SSE and WebSocket streams expose runtime events back to their connected callers. Both built-in channels accept the same optional synchronous `stream` transform:

```ts
interface StreamContext {
  agentName: string;
  instanceId: string;
  mode: 'message' | 'instance';
}

type StreamTransform = (event: FlueEvent, ctx: StreamContext) => FlueEvent | null;
```

One input event produces zero or one public output event; returning `null` drops it. The transform applies only at public transport boundaries: HTTP `POST` with `Accept: text/event-stream`, HTTP `GET /:id/stream`, and WebSocket outbound frames. It does not alter `runtime.deliver().events()`, `runtime.subscribe()`, persistence, or CLI output. If a transform throws, log the error and drop only that transformed public event; never alter, terminate, or poison the raw runtime stream.

The event system does **not** carry hidden channel-reply state. If a developer wants to reply in a thread, update a typing indicator, or post into a different service, they do that explicitly from agent/application code using the platform SDK or their own client.

### 3.5 The agent's internal scheduler

`agent.send` is fire-and-forget. The agent has an internal scheduler (separate from the dispatcher) that processes `send`s in order. If `onMessage` calls `send` twice in succession, both sends queue at the agent level; the model processes them in order, naturally seeing the second as a "next message" between turns.

**Concurrent send is not an error.** Calling `send` while a prior `send`'s work is still in-flight enqueues the new send. The agent's scheduler picks it up when ready.

**Where this scheduler lives:** on Cloudflare, in the DO. On Node, in the dispatcher's process memory. Implementer's call on the exact data structure; a simple FIFO queue with single-flight dispatch is sufficient for v1. The pending-send queue must be bounded and configurable. If it is full, `agent.send()` records failure for that operation so the originating message completion resolves with an error rather than creating unbounded memory growth.

### 3.6 HTTP channel behavior

The HTTP channel mounts at `/agents/:name`. Its routes:

- **`POST /agents/:name/:id`** — deliver a message. Body is `{ message?: string | UserContent, ...rest }`. The channel parses JSON first. If parsing fails, return 400 before dispatch. HTTP middleware registered through `http({ middleware })` runs inside the channel's Hono app around this route, so callers can reject requests, inspect headers/URL/IP/body, and attach normalized request-derived values for the channel to merge into dispatch metadata. The channel splits the body into `content = message` (or empty if absent) and `metadata = rest`, merges any middleware-provided request metadata, then calls `deliver(name, id, { content, metadata, channel: 'http' })` and returns based on the request's `Accept` header:
  - **`Accept: application/json`** (default) — return `202 Accepted` with `{ messageId, status: 'accepted' }`. Connection closes. No waiting.
  - **`Accept: text/event-stream`** — return `200 OK` with `Content-Type: text/event-stream`. Pipe `handle.events()` into the response. Stream closes when the message completes under the shared completion definition.
  - **Queue full** — return `429 Too Many Requests` with a queue-full error body; do not accept the message.
- **`GET /agents/:name/:id/stream`** — instance-level event stream. Pipes `subscribe(name, id)` into an SSE response. Stays open until the client disconnects. This stream is shared-instance visibility: it exposes all events for that `(agentName, instanceId)`, not only events associated with one HTTP request.

**No "wait for idle, return JSON" mode in v1.** Callers who need the result use SSE and collect.

**Body parsing rules:**
- If `Content-Type: application/json`, parse the JSON body. Split into `content` (from `message` key) and `metadata` (rest).
- If `message` is a string, that's the content. If `message` is an array of pi-ai content parts, that's the content. If `message` is absent, content is `""` (empty string — represents a webhook-style message with no text).
- The HTTP channel does not validate or deeply shape body-derived `metadata`. It passes through whatever's left after extracting `message`, then merges any middleware-provided request metadata according to the channel's documented precedence rule. Middleware is the intended way to flow HTTP-only request data such as selected headers, authenticated actor ids, or client-IP-derived tenancy into `msg.metadata` without exposing raw `Request` on the transport-agnostic agent surface.

**Options:**

```ts
import type { MiddlewareHandler } from 'hono';

interface HttpChannelOptions {
  /** Optional Hono middleware mounted around the HTTP channel routes. */
  middleware?: MiddlewareHandler | MiddlewareHandler[];
  /** Optional. Shapes public SSE events only; null drops an event. */
  stream?: StreamTransform;
}
```

Example:

```ts
http({
  middleware: async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${env.API_TOKEN}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('flueMetadata', {
      actorId: c.req.header('x-user-id'),
      userAgent: c.req.header('user-agent'),
    });
    await next();
  },
});
```

The built-in HTTP channel should document the convention it uses to read middleware-provided request metadata from the Hono context (the `flueMetadata` local above is illustrative unless the implementation settles on that exact key). The important design point is that the extensibility surface is ordinary Hono middleware, not a bespoke `auth` callback or one-off metadata hook.

### 3.7 WebSocket channel behavior

The WebSocket channel mounts at `/agents/:name/websocket`. Its routes (the channel can choose the exact URL shape under its namespace; this is the recommended layout):

- **`GET /agents/:name/websocket/:id`** — WebSocket upgrade. If `auth` is configured, the channel runs it at the handshake; on failure responds 401 and does not upgrade. After upgrade, the channel:
  - Subscribes to `subscribe(name, id)` for streamed runtime events. This is an instance-wide subscription: every subscriber for `(agentName, instanceId)` sees all public events for that instance.
  - On each inbound text frame, parses `{ message?, ...rest }` (same rules as HTTP), calls `deliver(name, id, { content, metadata, channel: 'websocket' })`.
  - Sends public runtime events as JSON-encoded WS frames.
  - For malformed inbound frames, emit a structured error frame and keep the socket open unless there is a protocol/socket-level error. This includes invalid JSON, wrong object shape, malformed `message` content arrays, and unsupported binary frames.
  - If delivery is rejected because a queue is full, emit a structured queue-full error frame for that inbound frame and keep the socket open.
  - Closes subscription on socket close.

**Cloudflare hibernation API:** on CF, the WebSocket channel should use the Hibernation API where possible so DOs can hibernate while sockets are open. The implementer should consult Cloudflare's docs and use `state.acceptWebSocket(ws)` / `state.getWebSockets()` rather than holding live event-listener references. Accepted sockets survive hibernation; live listeners/subscriptions do not. On wake, reconstruct socket broadcast bookkeeping from DO-resident dispatcher state and current accepted sockets, then reapply the public `stream` transform at write time for each outbound frame.

**Auth is at the handshake, not per-frame.** Once the socket is upgraded, frames are considered authenticated by virtue of the connection existing. Per-frame auth is out of scope for v1.

**Options:**

```ts
interface WebsocketAuthContext {
  req: Request;          // the upgrade request
  url: URL;
  headers: Headers;
  // Note: no body — WS upgrade has no body.
}

interface WebsocketChannelOptions {
  /** Optional. Runs at upgrade handshake. Returns truthy to accept; falsy/throw to reject. */
  auth?: (ctx: WebsocketAuthContext) => boolean | Promise<boolean>;
  /** Optional. Shapes public outbound frames only; null drops an event. */
  stream?: StreamTransform;
}
```

Example:

```ts
websocket({
  auth: ({ url }) => url.searchParams.get('token') === env.WS_TOKEN,
});
```

### 3.8 Internal channel / `runtime.deliver` exposure

The runtime exports `deliver` and `subscribe` as top-level functions:

```ts
import { deliver, subscribe } from '@flue/runtime';
await deliver('support', 'instance-1', 'Hello there', { source: 'cli' });
```

**For `flue run`:** the CLI path stays exactly as-is: it imports `deliver` from the in-process runtime (because `flue run` boots the runtime in-process), generates an instance id (or accepts one via `--id`), calls `deliver`, consumes raw `handle.events()`, prints those events to stderr, and waits on `handle.waitForIdle()` before exiting. Public HTTP/WS stream transforms do not touch this path.

**For `@flue/sdk` (in-process):** the SDK exposes a `flue.deliver(name, id, content, metadata?)` that, when used in-process, calls `runtime.deliver` directly. When used out-of-process (against a deployed agent), it falls back to HTTP. Out-of-scope for this plan; mentioning for context.

### 3.9 Hibernation, replay, and durability

**What persists across hibernation:**
- The agent's session history (via the existing session store).
- The agent's virtual workspace state (via the existing default-workspace-store).
- Completed message records (via the existing `RunStore`, which continues to store message records under the new semantics — see §3.10).
- Cloudflare WebSocket acceptance state and whatever DO-resident dispatcher metadata is needed to rebuild instance-wide broadcasting on wake; live listener closures do not persist.

**What does not persist across hibernation:**
- The in-memory `Agent` object returned by `init`. Re-created by re-running `init`.
- The in-memory message queue. **This is intentional:** by the time a message is in the queue, the caller has received an ack with the messageId. We do not promise durable delivery beyond the ack. Future direction: durable inbox.

**What about messages enqueued during init that fail when init fails?** They are not retried. The error is propagated to their `DeliveryHandle`. Callers can re-deliver if they want.

### 3.10 Run store → message store

The existing `RunStore` in `packages/runtime/src/runtime/run-store.ts` remains the internal persistence layer for invocation history in v1. The public/runtime semantics change: "runs" no longer exist as a first-class product entity, and `RunStore` records now represent messages under the new model. Keep the internal name for lower churn in this implementation plan. We track:

- **Messages**, with `messageId`, `agentName`, `instanceId`, `receivedAt`, `endedAt?`, `isError?`, optional `content` and `metadata` (configurable; some deployments may not want to log content).
- **Events**, append-only, tagged with `messageId` where applicable.

The current registry / subscriber / lifecycle code in `packages/runtime/src/runtime/` largely survives. The major surgery is in `handle-agent.ts` (which becomes the channel router rather than the run dispatcher) and in `instance-admission.ts` (which gets repurposed or deleted).

---

## 4. API surface — exhaustive

### 4.1 New exports from `@flue/runtime`

```ts
// Already exported (from prior plan); shapes preserved
export interface Agent { /* see §2.3 */ }
export interface AgentDefinition { /* unchanged */ }
export function defineAgent(def: AgentDefinition): AgentDefinition;
export interface SendOptions { session?: string; }

// New
export interface AgentContext { /* see §2.2 */ }
export interface InboundMessage { /* see §2.4 */ }
export interface DeliveryInput { /* see §2.5 */ }
export interface Channel { /* see §2.5 */ }
export interface ChannelContext { /* see §2.5 */ }
export interface DeliveryHandle { /* see §2.7 */ }
export interface EventStream extends AsyncIterable<FlueEvent> {
  cancel(): void;
}
export interface StreamContext { /* see §3.4 */ }
export type StreamTransform = (event: FlueEvent, ctx: StreamContext) => FlueEvent | null;

// New types re-exported from pi-ai for convenience
export type { UserContent, TextContent, ImageContent } from '@earendil-works/pi-ai';

// Channel factories
export function http(options?: HttpChannelOptions): Channel;
export function websocket(options?: WebsocketChannelOptions): Channel;
// Future third-party channels are out of scope for this plan.

// Runtime primitives
export function deliver(
  agentName: string,
  instanceId: string,
  input: DeliveryInput,
): Promise<DeliveryHandle>;
export function deliver(
  agentName: string,
  instanceId: string,
  content: UserContent,
  metadata?: Record<string, unknown>,
): Promise<DeliveryHandle>; // defaults channel to 'internal'
export function subscribe(agentName: string, instanceId: string): EventStream;
```

### 4.2 Removed exports from `@flue/runtime`

- `Role` type (already retired by previous plan; double-check no references remain)
- Old `triggers` shape — was a type literal on agent modules, not necessarily exported, but any helper types tied to it
- `AgentBusyError` — never gets exported because we never throw on concurrent send
- The old `FlueContext` `init(...)` signature that returned a harness, then later returned an Agent. The new shape is: agent modules export `init(ctx: AgentContext)` at the module level. No `FlueContext.init` exists.
- The old default-export handler signature (`(ctx: FlueContext) => unknown`). Agent modules export `init` + `onMessage` instead.

### 4.3 Module shape contract

A valid agent module exports:

```ts
// Required
export async function init(ctx: AgentContext): Promise<Agent>;

// Required (but framework provides a default if omitted: agent.send(msg.content))
export function onMessage(agent: Agent, msg: InboundMessage): void | Promise<void>;

// Optional
export const channels: Channel[];
```

**Module validation:** at module load (or first access), the framework validates that `init` is a function. If `onMessage` is omitted, the framework substitutes a default `(agent, msg) => agent.send(msg.content)`. If `channels` is omitted, the framework defaults to `[]` (only internal channel is available).

**Loud failure mode:** if `init` is absent, throw a clear error pointing at the module path: "Agent module `<path>` must export an `init` function."

### 4.4 What `FlueContext` looks like now

The previous plan's `FlueContext` (passed to default-export handlers) is gone. The new equivalent is `AgentContext`, passed to `init`. It has a strict subset of the old shape:

```ts
interface AgentContext {
  readonly id: string;
  readonly env: Env;
  readonly log: FlueLogger;
  readonly metadata: Record<string, unknown>;   // from the message that woke this agent
  spawn(options: SpawnOptions): Promise<Agent>;
  register(fn: () => Promise<void>): Promise<void>;
}
```

By convention, agent modules destructure these at the function signature: `export async function init({ spawn, register, env, id, metadata }: AgentContext) { ... }`. Don't write user-facing examples that hold a `ctx` reference.

Notable removals from the old shape:
- `payload` — gone as a top-level field. The channel-specific bag is `metadata`. Per-message metadata is on `msg.metadata` (in `onMessage`); cached-from-wake metadata is on `AgentContext.metadata` (in `init`).
- `req` — gone. `init` is transport-agnostic. Channel-specific request data lives in `metadata`.
- `runId` — gone. There are no runs.

**Semantics of `init`'s `metadata` vs `onMessage`'s `msg.metadata`:**
- `init` receives the `metadata` from the **first message of the wake** — i.e., the message that woke this agent. It's cached for the duration of the wake. If `init` doesn't run (agent already warm), this cached value persists.
- `onMessage` receives the **current message's** `metadata` via `msg.metadata`. It changes per message.
- These can differ when multiple messages arrive in the same wake. The channel's instance-id choice scopes the agent: if an instance represents one user, metadata may stay consistent; if an instance groups multiple senders, metadata can change per message and the agent built in `init` saw only the first message's snapshot. The channel/developer chose this scoping; the framework just exposes both views.

If the implementer encounters code paths that need the request object during init (e.g., for first-time auth setup), the right answer is: that's a per-message concern, not a per-wake concern. Move it to `onMessage` or to channel-level `auth`.

---

## 5. Implementation phases

Phases are listed in execution order. They are deliberately granular so an agent implementer has natural checkpoints. Each phase ends in a state where the codebase compiles and (where possible) some test or smoke-check passes. Phases are **not** strict — the implementer may combine where the combination saves work without losing the checkpoint property.

### Phase 0 — Pre-flight

**0.1** Read the full prior plan at `~/Documents/agent-init-and-send-implementation-plan.md`. Understand what landed before this work.

**0.2** Read `packages/runtime/src/runtime/handle-agent.ts` end-to-end. This is the file that changes most.

**0.3** Read `packages/runtime/src/runtime/instance-admission.ts` and both target-specific implementations (`packages/runtime/src/node/instance-admission.ts`, `packages/runtime/src/cloudflare/instance-admission.ts`). Understand what they do today; we are removing or repurposing them.

**0.4** Skim `pi-mono/packages/agent/src/` for the shape of `UserContent`, `UserMessage`, `Session`. Confirm `UserContent = string | (TextContent | ImageContent)[]` (in `pi-mono/packages/ai/src/types.ts`).

**0.5** Skim Hono's `mount()` documentation: <https://hono.dev/docs/api/hono#mount>. Confirm the API.

**Checkpoint:** implementer can articulate the change in one paragraph and can name the files they will touch.

### Phase 1 — New types and primitive declarations

Land all new types in `packages/runtime/src/types.ts` (or a new file `packages/runtime/src/channels.ts` if `types.ts` is getting unwieldy — implementer's call). No behavior yet.

**1.1** Add `InboundMessage` interface.
**1.2** Add `DeliveryInput`, `Channel`, and `ChannelContext` interfaces.
**1.3** Add `DeliveryHandle` interface.
**1.4** Add `EventStream` interface (cancel + AsyncIterable).
**1.5** Add `StreamContext` and `StreamTransform` for public transport stream shaping.
**1.6** Add `AgentContext` interface.
**1.7** Add `HttpChannelOptions`, `WebsocketChannelOptions` types with optional `stream?: StreamTransform`; HTTP channel options expose Hono middleware, while WebSocket handshake auth lands with that concrete channel below.
**1.8** Re-export `UserContent`, `TextContent`, `ImageContent` from pi-ai through the runtime's index.
**1.9** Update `Agent.send` signature to accept `UserContent` instead of just `string`. **Do not** update the underlying session.prompt signature yet (that's a wider change — see Phase 4).
**1.10** Add stub `http()`, `websocket()` factory functions returning `Channel` shape, but with placeholder `app` implementations that throw "not implemented." This is so consumers can start writing the new module shape.
**1.11** Update barrel exports in `packages/runtime/src/index.ts`.

**Checkpoint:** `pnpm run check:types` passes in `packages/runtime`. Type signatures are correct even though implementations are stubs.

### Phase 2 — The dispatcher

Build the dispatcher object in a new file `packages/runtime/src/runtime/dispatcher.ts`. This is a pure logical component; no Node/CF specialization.

**2.1** Implement `Dispatcher` class with state machine (`cold` / `initializing` / `ready` / `broken`).
**2.2** Implement `deliver(input: DeliveryInput)` returning `DeliveryHandle`; the public runtime overload may adapt content/metadata into `channel: 'internal'`. Materialize the first accepted cold delivery before init and capture its metadata for `AgentContext.metadata`.
**2.3** Implement the dispatch loop (`maybeDispatch`).
**2.4** Implement init attempt with failure handling and backoff.
**2.5** Implement `subscribe()` for instance-wide events.
**2.6** Wire event tagging so events emitted inside an `onMessage` invocation carry the relevant `messageId`. Use AsyncLocalStorage on Node; equivalent on CF.
**2.7** Implement per-message and per-instance EventStreams. Reuse `runtime/run-subscribers.ts` machinery where possible; if it's not a clean fit, write a small new helper.
**2.8** Implement `DeliveryHandle.events()` and `DeliveryHandle.waitForIdle()` using the shared completion definition: `onMessage` returned plus all sends enqueued during it finished.

**Checkpoint:** Unit tests for `Dispatcher` pass. Test cases:
- Cold → initializing → ready transition on first deliver.
- Init failure transitions to broken; new deliver during backoff fails immediately; new deliver after backoff retries.
- FIFO order of `onMessage` invocations.
- Single-flight: two concurrent `deliver` calls serialize through one `onMessage` at a time.
- `onMessage` async return is awaited before next dispatch.
- Events emitted during `onMessage` are tagged with the right messageId.
- First accepted cold delivery is materialized before init; init metadata comes from that delivery even when more cold deliveries race in.
- `message_end`, per-message SSE closure, and `waitForIdle()` all wait for `onMessage` return plus sends enqueued during that invocation.
- Bounded dispatcher queues reject overflow with queue-full.

### Phase 3 — Dispatcher registry

The dispatcher registry is target-specific (Node vs CF). It's the thing that gives us "one dispatcher per `(name, id)` instance."

**3.1 (Node)** In `packages/runtime/src/node/`, add `dispatcher-registry.ts`. A `Map<string, Dispatcher>` keyed by `agentName:instanceId`. Idle timer (default 5 minutes) evicts entries. Exposes `getOrCreate(name, id, module)`.

**3.2 (Node)** Wire the Node `runtime.deliver` overloads to look up the agent module by name, fetch-or-create a Dispatcher, normalize convenience content/metadata calls to `{ channel: 'internal' }`, and call `dispatcher.deliver(input)`.

**3.3 (CF)** In `packages/runtime/src/cloudflare/`, the dispatcher *is* the DO. There's no Map; the DO identity is keyed by the composite `(agentName, instanceId)`. Add or update `dispatcher-do.ts` (or wire into existing `registry-do.ts`). The DO holds the Dispatcher and exposes `deliver` as a DO method.

**3.4 (CF)** Wire the CF `runtime.deliver` overloads to normalize convenience content/metadata calls to `{ channel: 'internal' }`, look up the DO stub for composite `(name, id)`, and call its `deliver(input)` method (DO RPC, not `fetch()`).

**3.5** Add `runtime.subscribe(name, id)` for both targets, pointing at the dispatcher's instance-wide subscription.

**Checkpoint:** A test harness that boots the runtime, calls `runtime.deliver` against a trivial agent module (just `init` and a default `onMessage`), and observes events on the handle's event stream. Works on both Node and CF.

### Phase 4 — `Agent` value updates

The `Agent` value returned by `spawn` (formerly the in-handler `init({...})`) needs minor updates.

**4.1** Add `agent.send(content: UserContent, options?)` — accept `UserContent` not just `string`.
**4.2** Update `agent.send` to use the agent's internal scheduler. Remove "throw if busy" — concurrent sends queue.
**4.3** Wire `agent.send` so each queued operation captures `originMessageId` at enqueue time from the current `onMessage` scope. Resulting prompt events and completion accounting read that stored attribution, not ambient current-message state later.
**4.4** Widen `session.prompt(content: string | UserContent, options?)` in `packages/runtime/src/session.ts` to accept `UserContent`. The underlying pi-agent-core accepts this; the runtime just passes through.
**4.5** Enforce the v1 recursion guardrail: spawned secondary/subagent definitions do not automatically gain recursive spawn capability.

**Checkpoint:** Existing tests still pass after the widening. New tests: `agent.send([{ type: 'text', text: 'hi' }, { type: 'image', data: '...', mimeType: 'image/png' }])` works and the model receives the multipart message; spawned secondary/subagent definitions do not automatically gain recursive spawn capability.

### Phase 5 — Channels: the contract and the framework router

This is the channel mounting infrastructure. Channels themselves come in Phase 6+.

**5.1** Define the `Channel` value shape exactly as §2.5 specifies. The framework's channel-mounting code lives in `packages/runtime/src/runtime/channels.ts` (new file).

**5.2** Build the channel mounter. Given an agent name and a list of channels, produce a Hono sub-app rooted at `/agents/:name` with each channel mounted at its declared slot (`top` or `:name/<channelName>`).

**5.3** Validate reserved names: throw at mount time if a channel's `name` is in `['stream', 'messages', 'internal', 'admin']`.

**5.4** Validate uniqueness: throw at mount time if two channels share a `name`, or if more than one channel has `mount: 'top'`.

**5.5** Build the `ChannelContext` for each channel: `agentName` is the module's name, `env` is the runtime env, `deliver` is bound to `(instanceId, input) => runtime.deliver(agentName, instanceId, input)`, `subscribe` is bound to `(instanceId) => runtime.subscribe(agentName, instanceId)`. Channel implementations supply their own `input.channel` identities.

**5.6** Wire the agent module loader (in `runtime/flue-app.ts` and CF equivalent) to read the `channels` export from the module, default to `[]` if absent, and pass to the channel mounter.

**5.7** Implement a shared public stream-transform wrapper for transport writers. It accepts an `EventStream`, `StreamTransform | undefined`, and `StreamContext`; it preserves event order, cancellation, and downstream backpressure while passing through by default, dropping `null`, and yielding mapped events. Transform exceptions are logged and drop only that public output event; raw runtime streams continue unchanged.

**Checkpoint:** An agent module with `export const channels = []` mounts successfully (with only framework-reserved routes available). Shared wrapper tests cover pass-through, filtering, mapping/redaction, order, cancellation, bounded subscriber/output buffering, overflow handling, backpressure, and transform exceptions that leave raw streams unchanged.

### Phase 6 — The HTTP channel

This is the first real channel. Implement under `packages/runtime/src/channels/http.ts` (new directory).

**6.1** Implement `http(options?: HttpChannelOptions): Channel`. The returned `Channel` has `name: 'http'`, `mount: 'top'`, and an `app` function that returns a Hono app.

**6.2** The Hono app exposes:
- `POST /:id` — parse body, extract `message` and `metadata`, auth after successful parse, call `ctx.deliver(id, { content, metadata, channel: 'http' })`. Branch on `Accept`:
  - `application/json` (default): return 202 with `{ messageId }`.
  - `text/event-stream`: open SSE, pipe `handle.events()` through the shared stream wrapper with `mode: 'message'`, close when shared per-message completion fires.
  - queue-full delivery rejection: return 429 with a queue-full error payload.
- `GET /:id/stream` — open SSE, pipe `ctx.subscribe(id)` through the shared stream wrapper with `mode: 'instance'`, close on client disconnect. This endpoint is instance-wide and exposes all events for that instance.
- Reserve `:id/messages` (return 404 for v1; framework owns this path for future use).
- Reject reserved top-slot ids `stream`, `messages`, `internal`, and `admin` rather than treating them as HTTP instance ids.

**6.3** Body parsing: if Content-Type is `application/json`, parse JSON. If JSON parsing fails, return 400 before auth. If `message` is present, that's the content. The rest of the body becomes metadata. If `message` is present but malformed, return 400 before dispatch.

**6.4** Define `HttpChannelOptions` with optional Hono `middleware` and `stream` fields (signature in §3.6). Mount middleware around the HTTP channel routes so users can perform auth, inspect headers/body/url/IP, and stash request-derived metadata for dispatch translation without exposing raw `Request` to agents. Pass `stream` only into public SSE writers.

**Checkpoint:** A bare agent module with `export const channels = [http()]` accepts POSTs to `/agents/:name/:id` and returns 202 with a messageId; `Accept: text/event-stream` returns SSE. HTTP tests prove parse failure returns 400 before auth, auth receives parsed body, queue-full returns 429, reserved top-slot ids are not instance ids, instance streams expose all instance events, and public streaming supports pass-through plus filtering/redaction through `stream`.

### Phase 7 — The internal channel and `runtime.deliver` for the CLI

The internal channel doesn't mount routes, but we expose `runtime.deliver` and `runtime.subscribe` for in-process callers.

**7.1** Confirm the public exports of `@flue/runtime` include `deliver` and `subscribe`.

**7.2** Keep `flue run` on its existing in-process path: call `runtime.deliver(agentName, instanceId, content, metadata)` directly, consume raw `handle.events()`, print events to stderr, await `handle.waitForIdle()`, and exit. Do not apply public HTTP/WS stream transforms.

**7.3** Body for `flue run` is constructed from `--payload`: if `--payload` has a top-level `message` key, that's the content. The rest is metadata. (Same parsing as HTTP.)

**Checkpoint:** `flue run hello --id test-1 --payload '{"message": "hi"}'` works against an agent module with no channels declared (CLI bypasses channels via `runtime.deliver`).

### Phase 8 — The WebSocket channel

Implement under `packages/runtime/src/channels/websocket.ts`.

**8.1** Implement `websocket(options?: WebsocketChannelOptions): Channel` with `name: 'websocket'`, `mount: 'namespaced'`.

**8.2** The Hono app exposes:
- `GET /:id` — WebSocket upgrade. After upgrade:
   - Subscribe to `ctx.subscribe(id)`. Pipe events through the shared stream wrapper with `mode: 'instance'`, then send them to the socket as JSON frames. This is instance-wide visibility, not per-sender filtering.
   - On inbound text frame, parse `{ message?, ...rest }`, call `ctx.deliver(id, { content, metadata, channel: 'websocket' })`.
   - On invalid JSON, wrong object shape, malformed message arrays, unsupported binary frames, or queue-full delivery rejection, emit a structured error frame and keep the socket open unless a socket/protocol error requires close.
   - On socket close, cancel subscription.

**8.3 (CF)** Use the Hibernation API. Implementer must consult: <https://developers.cloudflare.com/durable-objects/api/websockets/>. Use `state.acceptWebSocket(ws)` so the DO can hibernate while sockets are open. Wake-up events come back through the DO's `webSocketMessage` and `webSocketClose` handlers. Accepted sockets survive; listener closures do not. Rebuild broadcast/subscription wiring from DO-resident dispatcher state on wake, and apply the public stream transform at outbound write time.

**8.4 (Node)** Use Hono's WebSocket helpers or the `ws` package directly. Implementer's call.

**8.5** Define `WebsocketChannelOptions` with optional `auth` and `stream` fields (signature in §3.7). If `auth` is provided, call it during the upgrade handshake; on falsy/throw, respond 401 and abort the upgrade. Pass `stream` only into public outbound frame writers.

**Checkpoint:** A WS client can connect to `/agents/:name/websocket/:id`, send a JSON frame, and receive events back. Both Node and CF. WS tests prove instance-wide subscriptions, structured error frames for malformed or rejected inbound frames without unnecessary close, Hibernation API wake reconstruction on CF, and default pass-through plus filtering/redaction through `stream`.

### Phase 9 — Module shape migration

Migrate the module loader to expect the new shape (`init` + `onMessage`) and remove the old default-export-handler path.

**9.1** In `runtime/flue-app.ts` (and CF equivalent), update agent module discovery to read `init` and `onMessage` exports. If `onMessage` is absent, substitute the default `(agent, msg) => agent.send(msg.content)`.

**9.2** If `init` is absent, throw at app construction with a clear message.

**9.3** If a module has *only* a default export and no `init`, treat it as an error in v1 (we are not maintaining backcompat per the user's instructions — early beta, no users depend on the old shape externally). Update example modules to the new shape.

**9.4** Remove the default-export dispatch path in `runtime/handle-agent.ts`. The file is being substantially rewritten anyway (see Phase 10).

**Checkpoint:** All examples in `examples/hello-world/.flue/agents/` and `examples/cloudflare/.flue/agents/` are migrated. `pnpm run check:types` and a smoke test pass for each.

### Phase 10 — Replace `handle-agent.ts` with the channel router

The big consolidation. `handle-agent.ts` today is a per-request dispatcher that runs the default-export handler. It becomes the entry point that routes incoming HTTP into the channel mounter.

**10.1** Replace `handle-agent.ts` with `agent-router.ts` (or rename in place). New logic: route `/agents/:name/...` into the channel sub-app for that agent.

**10.2** Remove `runWebhookMode`, `runSseMode`, `runSyncMode` — those modes are gone. The new logic is "find the channel mount, invoke its Hono app."

**10.3** Reuse `parseJsonBody`, `toHttpResponse`, error-handling — those don't change.

**Checkpoint:** Existing integration tests for `/agents/:name/:id` still pass, but now flowing through `http()` channel rather than handler-per-request logic.

### Phase 11 — Retire `instance-admission.ts`

The lane abstraction is now inside the dispatcher.

**11.1** Delete `packages/runtime/src/runtime/instance-admission.ts`, `packages/runtime/src/node/instance-admission.ts`, `packages/runtime/src/cloudflare/instance-admission.ts`.

**11.2** Update references — `handle-agent.ts` was the only consumer; should already be gone by Phase 10.

**11.3** Remove `InstanceBusyError` from `packages/runtime/src/errors.ts` (we no longer return 409 on concurrent inbound). Keep the error class around as a deprecated export for one minor version if there's risk of external consumers; per the user's instructions on early-beta backcompat, this is optional.

**Checkpoint:** Type check passes. No references to instance-admission remain.

### Phase 12 — Event renaming and message store

Rename run-level events and adapt the persistence layer.

**12.1** Rename event types in `runtime/events.ts`:
- `run_start` → `message_start` (carries `messageId`)
- `run_end` → `message_end` (carries `messageId`)
- Add `agent_wake` and `agent_idle` (instance-level, no `messageId`)

**12.2** Update event emitters in the dispatcher to emit the new event types.

**12.3** Keep `RunStore` as the internal name for now. Update its records, docs, and call sites so it stores message records under the new semantics; do not leave an implementer-choice rename branch in v1.

**12.4** Update the registry (`run-registry.ts`) similarly. This is the deployment-pointer index that lets `/runs/:runId/...` URLs find the owning instance. Same code structure, new names (or same names, new meaning).

**Checkpoint:** All event types are consistently named. Persistence layer reads and writes the new shape. Existing event-stream tests pass with renamed event types.

### Phase 13 — Examples

Update all example agent modules to the new shape.

**13.1** `examples/hello-world/.flue/agents/hello.ts` — convert from default-export to `init` + `onMessage` + `channels: [http()]`.

**13.2** `examples/hello-world/.flue/agents/with-inherit.ts` — same.

**13.3** Other examples (`with-image.ts`, `with-tools.ts`, `with-thinking.ts`, etc.) — same. These mostly demonstrate harness features and become "agent that does X in `onMessage`."

**13.4** Add at least two new examples that demonstrate the new shape's strengths:
- `examples/hello-world/.flue/agents/chat.ts` — `[http(), websocket()]`, `onMessage` just calls `agent.send`.
- `examples/hello-world/.flue/agents/long-running.ts` — single message, `onMessage` does 30 seconds of work, demonstrates that the "workflow" pattern is just an agent.

**Checkpoint:** All examples run via `flue run` and via `flue dev` + HTTP/SSE.

### Phase 14 — Tests

Comprehensive test coverage of the new behavior. Many of these are new tests; some replace existing ones.

**14.1** Dispatcher tests (in `packages/runtime/test/dispatcher.test.ts`):
- Cold-start init runs once.
- Messages enqueued during init dispatch after init resolves.
- FIFO ordering across many concurrent `deliver` calls.
- Init failure: enqueued messages fail; backoff observed; next deliver after backoff retries.
- Single-flight `onMessage`: two concurrent deliveries do not see overlapping `onMessage` invocations.
- Events emitted in `onMessage(N)` are tagged with N's messageId.
- Events emitted by `agent.send`-triggered work continuing after `onMessage(N)` returns still carry N's messageId via captured `originMessageId` on each queued send operation.
- `message_end`, per-message SSE closure, and `waitForIdle()` fire only after `onMessage(N)` returns and all sends enqueued during it finish.
- Bounded dispatcher pending-message, agent pending-send, and subscriber/output buffers reject or fail explicitly rather than growing unbounded.

**14.2** Channel mounter and shared stream-wrapper tests:
- Reserved channel names throw at mount.
- Duplicate channel names throw.
- Multiple `mount: 'top'` channels throw.
- Channel `app` is mounted at the right URL.
- Stream wrapper defaults to pass-through, supports filtering and mapping/redaction, preserves order, cancellation, bounded output buffering, and backpressure, and logs/drops transform exceptions without altering raw streams.

**14.3** HTTP channel tests:
- POST with JSON body, `Accept: application/json` returns 202 with messageId.
- POST with JSON body, `Accept: text/event-stream` returns SSE.
- GET `/:id/stream` returns instance-level SSE and includes all events for that instance.
- Public SSE streams default to pass-through and apply `stream` filtering plus mapping/redaction when configured.
- Body parsing: `{ message, ...rest }` splits into content + metadata.
- Body with no `message`: content is `""`, full body is metadata.
- HTTP middleware can reject requests or enrich request-derived dispatch metadata without widening the generic agent message surface.
- Invalid JSON returns 400 before auth; auth receives the parsed body and runs before dispatch.
- Queue-full delivery rejection returns 429.
- Reserved top-slot ids are rejected rather than treated as valid HTTP instance ids.

**14.4** WebSocket channel tests:
- WS connect, send frame, deliver flows through. Receive frame with assistant content. Both Node and CF.
- Instance-wide WS subscription exposes all events for that instance.
- Invalid JSON, wrong shape, malformed message arrays, unsupported binary frames, and queue-full delivery rejection emit structured error frames and keep the socket open absent protocol/socket failure.
- Outbound frames default to pass-through and apply `stream` filtering plus mapping/redaction when configured.
- CF hibernation wakes with accepted sockets intact, rebuilds broadcast state, and reapplies stream transforms at write time.

**14.5** CLI tests:
- `flue run` with no channels declared still works (uses `runtime.deliver`).
- `flue run` with channels declared still works the same way.
- Public HTTP/WS `stream` transforms do not alter raw CLI output from `handle.events()`.

**14.6** End-to-end: at least one agent-style and one long-running agent exercised through `flue run` and through `flue dev` (HTTP + WS + SSE), on both Node and Cloudflare targets.

**Checkpoint:** All tests pass.

### Phase 15 — Documentation

Documentation is part of the deliverable. Without docs, the new model is unreachable.

**15.1** Update top-level `README.md`:
- Replace the "agents and workflows" language with "agents."
- Show the new `init` + `onMessage` + `channels` module shape.
- Show HTTP, WS, and CLI invocation.

**15.2** Update root `AGENTS.md`:
- New terminology table:
  - Agent (module) — `.flue/agents/<name>.ts`, exports `init` + `onMessage` + optional `channels`.
  - AgentInstance — URL `<id>` or continuation-token-derived id; addresses a specific running agent.
  - Channel — transport adapter; produces a Hono sub-app; translates external events into `runtime.deliver` calls.
  - Message — `InboundMessage` envelope; framework-owned; carries `UserContent` to the agent.
  - Harness — `agent.harness()`; reach-down for low-level control.
  - Session — `harness.session(name?)`; conversation history.
- Remove all mentions of "workflow" as a separate concept. The word can still appear as a description of an interaction pattern ("a workflow-style agent does its work in one long-running `onMessage`") but not as a distinct module type.

**15.3** Create `docs/channels.md`:
- Conceptual model.
- HTTP channel: routes, body shape, response modes.
- WebSocket channel: routes, frame shape, hibernation.
- Internal channel: what it is, how `flue run`/SDK use it.
- How to write your own channel.

**15.4** Create `docs/migration-from-default-export.md`:
- For each old pattern, the new equivalent.
- Why the change.
- The two-export shape.
- How `ctx.payload` becomes `msg.content` / `msg.metadata`.

**15.5** Update `docs/deploy-*.md` files where they reference the old shape.

**15.6** Update CHANGELOG.

**Checkpoint:** A new user can read the docs and write a working agent in 15 minutes. (Self-test: read the docs as the implementer and confirm.)

### Deferred follow-up — social and webhook channels

Slack, Google Chat, Discord, and similar integrations are intentionally **not** part of this plan. They are valuable, but "just add social" is a large product/API design problem, especially once signature verification, event variants, threading, typing indicators, interaction tokens, and cross-channel posting enter the picture.

This plan should leave room for those channels later by preserving three constraints:

1. Future channels may have arbitrary inbound transport, with Flue-managed event streaming only when that transport calls for it.
2. `instanceId` derivation stays a channel/developer choice, not a framework default.
3. Replies, edits, typing indicators, and cross-channel posting remain explicit application code unless a future dedicated design proves a smaller abstraction; there is no platform reply orchestration here.

Any future social-channel plan should be written separately and should not reopen the core dispatcher/runtime work in this document.

### Appendix note on removed draft material

Earlier drafts of this plan included detailed Slack, Google Chat, and Discord implementation sketches. Those sections are intentionally removed from the active execution plan to keep this document focused and implementable.

---

## 6. Open implementation details

Decisions intentionally left to the implementer, to resolve during the work:

- **AsyncLocalStorage vs DO-state for messageId tagging**: Node uses ALS, CF uses DO-resident state. Likely a small abstraction over both.
- **Idle timeout default on Node**: 5 minutes is a defensible starting point. Implementer can make it shorter if testing demands.
- **Init backoff duration**: 5 seconds is a defensible starting point. Implementer can tune.
- **WS auth pattern**: bake an `auth` option into `websocket()` or rely on Hono middleware. Either is acceptable.
- **Existing `triggers` references**: search the codebase for `triggers` and remove or migrate. Most/all examples have `export const triggers = { webhook: true }` which becomes `export const channels = [http()]`.
- **Existing `payload` references**: the old `ctx.payload` is gone. Update any docs, helper types, and tests that referenced it.
- **EventStream implementation**: AsyncIterable over a Push stream / Channel. There are existing patterns in `runtime/run-subscribers.ts` to start from. The public `stream` wrapper must stay synchronous and preserve order, cancellation, configurable bounded buffering, and backpressure. Buffer overflow policy must be explicit rather than unbounded.

---

## 7. Migration notes

### 7.1 Migration for existing agent modules

Old:

```ts
export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({ inherit: support });
  agent.send(payload.message);
}
```

New:

```ts
export const channels = [http()];

export async function init({ spawn }: AgentContext) {
  return await spawn({ inherit: support });
}

export async function onMessage(agent, msg) {
  agent.send(msg.content);
}
```

Mechanical translation:
- `triggers = { webhook: true }` → `channels = [http()]`.
- The default export splits into `init` (the `spawn` call) and `onMessage` (everything after).
- `payload.message` → `msg.content`. Other fields of `payload` go in `msg.metadata`.
- The in-handler `init({ ... })` factory is renamed to `spawn({ ... })`.
- Destructure `{ spawn, register, ... }` at the function signature, matching the existing codebase style.

### 7.2 Migration for workflow-style code

Old workflow:

```ts
export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({ inherit: summarizer });
  const session = await agent.harness().session();
  return session.prompt(`Summarize: ${payload.issue}`);
}
```

New (functionally equivalent):

```ts
export const channels = [http()];

export async function init({ spawn }: AgentContext) {
  return await spawn({ inherit: summarizer });
}

export async function onMessage(agent, msg) {
  const session = await agent.harness().session();
  await session.prompt(`Summarize: ${msg.metadata.issue}`);
  // Note: no return value. The result lives in the session and on the event stream.
  // Callers wanting the result use SSE.
}
```

**Key behavioral change:** the old default-export's return value populated the POST response body. The new shape has no such concept — POST returns 202 immediately with a messageId, and results flow on the event stream. Callers that need the result must use SSE (`Accept: text/event-stream`).

If a caller relies on a JSON response body, they need to change. We accept this break per the early-beta backcompat policy.

### 7.3 Migration for `flue run` consumers

`flue run <agent> --payload '{"foo": "bar"}'` previously delivered `payload = {foo: "bar"}` to the handler. Now:

- If the payload has a top-level `message` key (string or `UserContent`), that becomes `msg.content`.
- The rest of the payload becomes `msg.metadata`.

So `--payload '{"message": "hi"}'` puts "hi" in content. `--payload '{"foo": "bar"}'` puts nothing in content and `{foo: "bar"}` in metadata.

### 7.4 SDK callers

If `@flue/sdk` exists and is in use, it needs an update to send messages in the new shape: `{ message, ...metadata }` body, expect 202 + messageId, optionally connect to SSE for events.

---

## 8. Non-goals for this plan

Explicitly out of scope. The implementer should not bake assumptions that prevent these.

- **Cross-channel hand-off** (Ash's `args.receive(otherChannel, ...)`). One inbound channel pivoting to another channel for the response. Useful future direction; the design leaves space.
- **Channel-typed metadata**. `msg.metadata` is `Record<string, unknown>`. No per-channel TypeScript types in v1.
- **Mid-stream cancellation / interrupt signals**. Future social transports or application code may want to stop work mid-tool-call. Future direction; v1 just lets the work complete.
- **Outbound social response helpers**. Posting, editing, typing indicators, and similar response orchestration remain explicit application code unless a future dedicated design proves a smaller abstraction.
- **Cross-channel or reply-target re-keying**. Continuation-token or thread-anchor schemes that change an instance's response target after first delivery are out of scope for this plan.
- **Durable inbox**. Messages enqueued in the dispatcher do not persist across hibernation. Future direction; v1 acknowledges this and accepts ack-not-durable semantics.
- **Wait-for-idle HTTP mode**. POSTing and getting the final assistant message in the body, like the old workflow handler. Not in v1; clients use SSE.
- **Polling endpoint for completed messages**. `GET /:id/messages/:messageId` to fetch a completed message's final state. Reserved URL; not implemented in v1.
- **Per-tenant filtering inside shared instance streams.** `GET /:id/stream` and WebSocket subscriptions intentionally expose all events for that instance. Channel auth and instance-id design are responsible for tenant isolation.
- **Interactive CLI / REPL mode** for `flue run`. The CLI today is one-shot. A REPL mode where you type messages into a running agent is a known user request but not in v1.

---

## 9. Acceptance checklist

The implementation is successful when all of the following are true:

1. Agent modules export `init` and (optionally) `onMessage`. Default exports are no longer used as request handlers.
2. `channels` export, when present, mounts channels at the right URLs. Reserved names and duplicates throw loudly.
3. `runtime.deliver` exposes the canonical `@flue/runtime` export, supports explicit `DeliveryInput` plus ergonomic content/metadata convenience calls defaulting to `channel: 'internal'`, and returns a `DeliveryHandle` with `messageId`, `events()`, and `waitForIdle(): Promise<{ error?: unknown }>`.
4. The HTTP channel mounts at `/agents/:name` (top slot), parses JSON before auth, returns 400 for parse failures before auth, returns 202 or SSE based on `Accept`, returns 429 for queue-full rejection, rejects reserved top-slot ids, and applies optional `stream` shaping only to public SSE boundaries.
5. The WebSocket channel mounts at `/agents/:name/websocket`, handles inbound frames and streams public runtime events through optional outbound `stream` shaping. Malformed/rejected inbound frames emit structured error frames without closing absent protocol/socket failure. Uses CF Hibernation API on CF with wake-time broadcast reconstruction.
6. The dispatcher enforces FIFO `onMessage` invocations, awaits async `onMessage` returns, materializes the first accepted cold delivery before init so it owns wake metadata, and handles init failure with backoff.
7. Message completion is defined once: `onMessage` returned plus every `agent.send()` operation enqueued during it finished. `message_end`, per-message SSE closure, and `waitForIdle()` use that definition. Events from queued sends use captured `originMessageId`; the shared synchronous public stream wrapper preserves order, cancellation, bounded buffering, and backpressure while allowing zero-or-one event filtering/mapping at transport boundaries only. Transform exceptions log and drop only that public event.
8. `flue run` works for an agent with no `channels` declared (uses `runtime.deliver` directly, bypassing all channels) and continues to consume raw `handle.events()` even when HTTP/WS stream transforms exist.
9. `agent.send` accepts `UserContent`, not just `string`. Image/file inputs work.
10. Concurrent `agent.send` calls queue at the agent's internal scheduler. No `AgentBusyError` is thrown.
11. Old `triggers` field is removed; old default-export handler path is removed.
12. `instance-admission.ts` is removed; the lane behavior is inside the dispatcher.
13. Event types renamed: `run_start`/`run_end` → `message_start`/`message_end`, plus `agent_wake`/`agent_idle`.
14. All examples migrated to the new shape and verified.
15. Tests cover: dispatcher state machine, channel mounting, the shared stream wrapper including transform exceptions, HTTP channel auth/429/reserved-id semantics, WS malformed-frame and queue-full errors, CLI raw output unaffected by transforms, bounded queues/buffers, recursion guardrails, and end-to-end on both targets.
16. Shared instance streams are documented and enforced: `GET /:id/stream` and WS subscriptions expose all events for an instance, with tenant isolation owned by channel auth and instance-id design.
17. Spawned secondary/subagent definitions do not automatically gain recursive spawn capability.
18. Docs reflect the new model. CHANGELOG updated.
19. Both Node and Cloudflare targets are exercised end-to-end.

---

## 10. Reference: settled design rationale

For implementers who hit an unforeseen question, the principles to apply, in priority order:

1. **One module shape.** `init` + `onMessage`. Agents that look like "workflows" are just agents whose `onMessage` runs long. There is no separate workflow path; do not add one.
2. **Channels are transport adapters, not orchestrators.** HTTP/SSE and WebSocket convert inbound transport events into calls to `runtime.deliver` and stream runtime events back to the connected caller. They do not own agent lifecycle, init logic, message ordering, or platform reply orchestration. Those belong elsewhere.
3. **The dispatcher is single-flight on `onMessage` per `(agentName, instanceId)`.** Two messages do not run their `onMessage` concurrently. This is the framework's only ordering guarantee. The implementer must preserve it.
4. **`runtime.deliver` is the contract; channels are convenient transports above it.** Any in-process caller — CLI, SDK, subagent — uses `runtime.deliver` directly. Public HTTP/WS `stream` transforms touch only transport outputs, never raw delivery handles, subscriptions, persistence, or CLI output.
5. **POST is fire-and-ack.** `Accept: application/json` returns 202 + messageId. Clients that want the result use SSE. Do not bring back a "wait for idle, return body" mode in v1.
6. **`agent.send` never throws on busy.** Concurrent sends queue at the agent's internal scheduler. The previous plan's `AgentBusyError` is gone.
7. **Pi-ai owns the message format.** `UserContent = string | (TextContent | ImageContent)[]`. The framework's `InboundMessage` wraps it with framework metadata (`channel`, `messageId`, `sender`, `metadata`) but does not invent a new content shape.
8. **Hono is the channel surface.** Channels return Hono apps. Channel authors get the full Hono ecosystem (middleware, validators, route grouping) for free.
9. **Reserved names without underscore.** Framework owns `stream`, `messages`, `internal`, `admin`. Channels cannot claim these. Errors are loud at startup.
10. **Init runs once per wake; not per message.** Per-message work goes in `onMessage`. The first accepted cold delivery is materialized before init and owns wake metadata. This is the biggest mental shift from the previous shape; teach it explicitly in docs.
11. **Instance-wide streams are intentionally shared.** `GET /:id/stream` and WS subscriptions show all events for `(agentName, instanceId)`; auth and instance-id design provide tenant isolation.

If the implementer finds a tradeoff this document doesn't cover, apply the principles above in priority order. When in doubt, ship the smaller, more constrained v1. We have intentionally left space for many future directions (cross-channel hand-off, durable inbox, mid-stream cancellation, platform reply orchestration) without baking in any of them. The implementer's job in v1 is the core — do not creep scope toward those future features unless they are trivially within reach.
