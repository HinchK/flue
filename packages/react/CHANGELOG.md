# @flue/react

## 2.0.8

### Patch Changes

- Updated dependencies [9d649bc]
  - @flue/sdk@2.0.8

## 2.0.7

### Patch Changes

- 6e62278: Fix `useFlueAgent` callbacks changing identity on every store update — they now stay stable until the underlying session changes, preventing unnecessary re-renders and stale-effect churn.
- Updated dependencies [1f6238a, ef0c89f]
  - @flue/sdk@2.0.7
## 2.0.5

### Patch Changes
- Published packages once again resolve internal Flue dependencies to the release version.
## 2.0.0

### Patch Changes
- Agent authoring is rewritten: an agent is a plain exported function configured with hooks, and `defineAgent` is removed.
- The SDK and React hooks address one conversation by URL.
- `@flue/react`'s `useFlueAgent()` now exposes `refresh()`.
