---
"@flue/runtime": patch
---

Fix lost tool results when a submission is aborted mid-batch: completed tool calls keep their stored outcomes, and unexecuted calls are recorded as interrupted instead of being dropped.