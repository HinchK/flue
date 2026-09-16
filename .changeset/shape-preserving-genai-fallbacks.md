---
"@flue/runtime": patch
---

GenAI trace content now stays schema-valid when it cannot be fully represented: oversized, unserializable, or transform-failing messages under `gen_ai.input.messages` / `gen_ai.output.messages` fall back to a shape-preserving `role: "flue"` message (output fallbacks keep `finish_reason`) instead of a bare diagnostic string or an array element that violates the message schema.