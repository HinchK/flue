---
"@flue/runtime": patch
---

The Cloudflare binding's Anthropic gateway path now maps the agent's `thinkingLevel` to an adaptive-thinking effort (`output_config.effort`), so `useModel` thinking levels take effect on adaptive-thinking models instead of always running at Anthropic's default.