---
"@flue/runtime": patch
---

Fix duplicate responses appearing after a model stream fails partway through and Flue retries it successfully. Clients now see only the successful replacement response instead of the incomplete first attempt followed by the complete retry.
