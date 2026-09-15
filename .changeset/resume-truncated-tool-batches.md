---
"@flue/runtime": patch
---

Fix submissions failing when a model length limit truncates a tool call batch — truncated batches now resume cleanly with their outcomes reconstructed instead of erroring out.