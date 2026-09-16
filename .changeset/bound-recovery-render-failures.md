---
"@flue/runtime": patch
---

Interrupted submissions no longer retry forever when the recovery render throws: once the submission's durability deadline passes, a submission whose classification render keeps failing is settled as timed out instead of being re-rendered on every supervisor wake without ever consuming an attempt.