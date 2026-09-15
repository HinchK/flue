---
"@flue/runtime": patch
---

Tools without an output schema can now return union-shaped results — inferred branch unions, optional object properties, readonly arrays, and explicit `undefined` — and still typecheck, matching what the runtime actually serializes.