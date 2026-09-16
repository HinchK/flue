---
"@flue/runtime": patch
---

The Cloudflare binding provider now accepts a `cacheRetention` option (`'short'` or `'long'`) to enable Anthropic prompt caching for `anthropic/…` gateway models — repeated prefixes are served from cache at the cached input rate instead of paying full input price every turn. Default `'none'` keeps the previous behavior.