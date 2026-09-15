---
"@flue/runtime": patch
---

Cloudflare traces now carry submission, operation, and turn identifiers on agent, task, model, tool, and shell spans, so trace fragments can be correlated across durable invocations.