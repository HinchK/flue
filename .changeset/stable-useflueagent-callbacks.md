---
"@flue/react": patch
---

Fix `useFlueAgent` callbacks changing identity on every store update — they now stay stable until the underlying session changes, preventing unnecessary re-renders and stale-effect churn.