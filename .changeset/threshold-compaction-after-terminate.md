---
"@flue/runtime": patch
---

Sessions that end through a terminating tool now compact their context as expected, so the next turn starts from a manageable context instead of continuing to grow.