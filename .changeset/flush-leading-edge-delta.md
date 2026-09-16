---
"@flue/runtime": patch
---

Fix the first streamed delta being delayed by the full coalescing interval: after a quiet period, the first delta now flushes to the durable stream immediately, so observers see output as soon as the model starts responding.