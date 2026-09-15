---
"@flue/runtime": patch
---

Fix Workers AI conversations stalling on tool-call-only turns — `null` or missing assistant content is treated as an absent text delta, and malformed non-string content is rejected with a clear error instead of being silently dropped.