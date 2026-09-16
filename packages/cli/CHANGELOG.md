# @flue/cli

## 2.0.8

### Patch Changes

- 9d649bc: The Cloudflare Sandbox documentation page now presents `flue add sandbox cloudflare` as a copyable prompt for your coding agent, with an explainer of what the blueprint-driven agent may do — installing `@cloudflare/sandbox`, wiring the Durable Object binding, migration, and container `Dockerfile`, and updating the agent to use the sandbox.
- Updated dependencies [aaefa69, 3d7a0ef, 3a6242f, 9d649bc, 2d800f5, 3f3daae, 28e1afe, c5b1e25]
  - @flue/runtime@2.0.8
  - @flue/vite@2.0.8

## 2.0.7

### Patch Changes

- 1f6238a: Installed packages once again include the bundled Flue documentation, so commands such as `flue docs read guide/sandboxes` work out of the box.
- Updated dependencies [b8c07bb, 4b436f7, c1ceacd, c663410, 96b8f0b, 1f6238a, da7c085, 21c6240, 2227864, 68dbb37, 7527739, 750f1f1, 4a86eaa, d830034]
  - @flue/runtime@2.0.7
  - @flue/vite@2.0.7
## 2.0.6

### Patch Changes
- Published packages once again include the bundled Flue documentation.
## 2.0.5

### Patch Changes
- Published packages once again resolve internal Flue dependencies to the release version.
## 2.0.3

### Patch Changes
- The Cloudflare Agents SDK (`agents`) is now a dependency of `@flue/vite` — projects no longer declare it.
## 2.0.2

### Patch Changes
- The `cloudflare-shell` blueprint is replaced by `cloudflare-computer`.
- New docs reference page: [Agent Behavior](https://flueframework.com/docs/reference/agent-behavior/).
## 2.0.0

### Patch Changes
- Workflows are removed.
- The `@flue/dev-console` TUI package is removed.
- `flue run` is rewritten as transport-free local execution, and the CLI slims to `run`/`init`/`add`/`update`/`docs`.
- `vite dev` on the Node target now loads the project's `.env` file set into the application environment.
- `flue init` is now interactive and scaffolds the full project skeleton.
- Wrong-environment import failures now print the import chain naming the route to the problem.
