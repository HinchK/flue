---
"@flue/runtime": patch
---

Models synthesized from a dynamic model template (providers that serve model IDs beyond their catalog, such as Workers AI) are now detectable via the exported `isDynamicModel()` helper, and the runtime warns once when such a model is first resolved — previously their cost silently read as $0 with no way to tell "free" apart from "unknown".