---
"@flue/runtime": patch
---

Fix infinite recursion when a harness tool invokes another harness tool, directly or indirectly. Parallel tool calls remain independent, and unrelated tools sharing a public name are still allowed.