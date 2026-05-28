# LobeHub

> Part of [homelab-apps](../../README.md) — self-hosted AI chat frontend.

Deploys [LobeHub](https://github.com/lobehub/lobe-chat) with:
- Local LLM inference via [local-ai](https://github.com/digitaleraluhut/local-ai) (Qwen3, Devstral, etc.)
- ParadeDB (Postgres + pgvector) for conversation storage and RAG
- Brave Search integration for web-grounded answers
- Image generation via local ComfyUI/FLUX
- OAuth2-Proxy authentication (GitHub)

## Endpoints consumed

| Service | Source | URL |
|---------|--------|-----|
| LLM (chat/completions) | local-ai | `http://flinker:8080/v1` |
| Embeddings | local-ai | `http://flinker:8080/v1` |
| STT (whisper) | local-ai | `http://flinker:8081` |
| Image generation | local-ai | `http://flinker:8082/v1` |
