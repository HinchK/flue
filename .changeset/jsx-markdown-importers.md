---
"@flue/vite": patch
---

Markdown importers written in JSX (`.tsx`/`.jsx`) are now scanned correctly. SKILL.md imports that belong to the Agents SDK's virtual skill registry are left to its owning plugin instead of being claimed by Flue's transform.