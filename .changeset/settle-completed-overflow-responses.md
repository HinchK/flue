---
"@flue/runtime": patch
---

Fix conversations erroring with `Cannot continue from message role: assistant` after context compaction. A completed response is now preserved through overflow compaction, so the next turn continues normally; only genuine provider overflow errors trigger a retry.