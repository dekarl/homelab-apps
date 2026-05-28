# Matrix

> Part of [homelab-apps](../../README.md) — private messaging with voice transcription.

Deploys a Matrix homeserver with messaging bridges and AI-powered voice transcription:
- [Conduit](https://conduit.rs/) — lightweight Matrix homeserver
- [mautrix-whatsapp](https://github.com/mautrix/whatsapp) / [mautrix-signal](https://github.com/mautrix/signal) — bridge WhatsApp and Signal into Matrix
- Voice transcription bot — transcribes voice messages using Whisper STT, summarizes with LLM

## Endpoints consumed

| Service | Source | URL |
|---------|--------|-----|
| STT (whisper) | local-ai | `http://flinker:8081` |
| LLM (summarization) | local-ai | `http://flinker:8080/v1` |
