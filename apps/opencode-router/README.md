# OpenCode Router

> Part of [homelab-apps](../../README.md) — remote AI coding sessions.

Deploys per-user isolated [OpenCode](https://opencode.ai/) instances with:
- Dynamic Cloudflare DNS routing per session
- OAuth2-Proxy authentication (developers-only allowlist)
- Automatic lifecycle management (spin up on demand, tear down on idle)

Connects to [local-ai](https://github.com/digitaleraluhut/local-ai) for code completion and chat via the local LLM endpoint.
