# @flue/opentelemetry

## 2.0.8

### Patch Changes

- Updated dependencies [aaefa69, 3d7a0ef, 3a6242f, 9d649bc, 2d800f5, 3f3daae, 28e1afe, c5b1e25]
  - @flue/runtime@2.0.8

## 2.0.7

### Patch Changes

- Updated dependencies [b8c07bb, 4b436f7, c1ceacd, c663410, 96b8f0b, 1f6238a, da7c085, 21c6240, 2227864, 68dbb37, 7527739, 750f1f1, 4a86eaa]
  - @flue/runtime@2.0.7
## 2.0.5

### Patch Changes
- Published packages once again resolve internal Flue dependencies to the release version.
## 2.0.0

### Patch Changes
- Assistant output projects as one conversation message per response.
- The `flue.dispatch.id` telemetry attribute is removed.
- Trace content is captured by default, and `@flue/opentelemetry`'s content surface collapses to `content?: false | { transform }`.
- `GEN_AI_SCHEMA_URL` is removed, and `@flue/opentelemetry`'s tracer/meter no longer declare a `schemaUrl`.
- `createCloudflareTracing()` now captures conversation content into Workers Traces by default; `content: false` restores content-free spans.
- `@flue/opentelemetry` now reserves the Stable `exception.type` attribute for the exception class name.
- Both trace backends now stamp `gen_ai.agent.name` on `execute_tool` spans and close the attribute gap with `@flue/opentelemetry`.
- Coordinator recovery failures now reach both tracing adapters and the Sentry blueprint.
- On Cloudflare, the whole agent response now runs inside the Durable Object's own alarm invocation.
