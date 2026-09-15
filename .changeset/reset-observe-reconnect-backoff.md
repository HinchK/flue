---
"@flue/sdk": patch
---

Fix delayed reconnects in `observe()`: after a stream has been healthy for a full stream lifetime, the reconnect backoff resets, so a subsequent disconnect reconnects promptly instead of applying a stale delay.