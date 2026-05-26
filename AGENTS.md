# Flue

Agent framework where agents are directories compiled into deployable server artifacts.

## Terminology

```
Agent profile                 — one reusable `defineAgentProfile(...)` value
Created agent                 — one runtime initializer from `createAgent(...)`
Agent module                  — `agents/<name>.ts`; default-exports a created agent
└─ AgentInstance              — URL `<id>`; provided to `createAgent(({ id }))`
   └─ Harness                 — runtime-initialized agent environment; defaults to name `"default"`
      └─ Session              — one `harness.session(name?)`; defaults to `"default"`
         └─ Operation        — one `session.prompt` / `skill` / `task` / `shell` call
            └─ Turn          — one LLM round-trip inside pi-agent-core
Workflow                     — `workflows/<name>.ts`; exports `run(...)`
└─ Workflow run/invocation    — unique `ctx.id === runId`; initializes local created agents via `init(agent)` when needed
```

Runs are workflow-only. Direct HTTP/WebSocket agent prompts and dispatched agent inputs operate within persistent sessions and must not be described as runs. `dispatch(...)` is identified by `dispatchId`; `/runs` and `flue logs` inspect workflow runs only.

Use `harness` as the variable name for the return value of `init()`. Agents have names; agent instances have ids; harnesses and sessions have names; operations have generated ids.

## Project Structure

- `packages/runtime/` — Runtime library (`@flue/runtime`): sessions, agent harnesses, tools, and sandbox plumbing.
- `packages/cli/` — CLI and build/dev tooling (`@flue/cli`): Vite build graph, target integration, discovery, and configuration.
- `examples/hello-world/` — General runtime integration fixture.
- `examples/cloudflare/` — Cloudflare integration fixture.
- `examples/imported-skill/` — Packaged skill and release fixture.

Agent and workflow sources use either `<root>/.flue/` or `<root>/`; when `.flue/` exists, the bare `agents/` and `workflows/` layout is ignored.

## Development

Build runtime before CLI or examples:

```
pnpm run build          # in packages/runtime/
pnpm run build          # in packages/cli/
```

Type-check runtime changes with:

```
pnpm run check:types    # in packages/runtime/
```

When using `task` to delegate to subagents, you MUST include a notice that the subagent must not spawn its own subagents.

When accepting `review` task feedback, take durability and reliability bugs and improvement suggestions seriously, but avoid design churn. Reviews will almost always return something; apply a high bar for actionable feedback.

When writing new plans to disk, write them to `plans/` (gitignored intentionally) with a `YYYY-MM-DD` filename prefix.

Prefer changes that simplify the system over narrow patches that preserve accidental complexity. When fixing a bug or adding a feature, look for shared abstractions or obsolete branches that can be removed as part of the change, especially when this reduces distinct code paths or semantics. Do not expand into speculative redesign; call out meaningful user-facing behavior or migration tradeoffs before simplifying them away.
