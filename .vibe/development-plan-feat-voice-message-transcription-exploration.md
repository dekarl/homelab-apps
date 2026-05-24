# Development Plan: Voice Message Transcription Unified Inbox

*Generated on 2026-05-21 by Vibe Feature MCP*
*Workflow: [greenfield](https://codemcp.github.io/workflows/workflows/greenfield)*

## Goal

Build a fully automated voice message transcription pipeline.
Voice messages from WhatsApp, Signal, and iMessage are automatically captured via Matrix bridges,
transcribed using self-hosted Whisper, summarized via OpenRouter, and posted back as replies in
the original Matrix conversation — giving the user a unified, searchable, text inbox for all
voice messages. Architecture is designed to forward transcripts to a LobeHub AI agent in a future phase.

---

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | **Matrix as the ingestion layer** | Only protocol with production bridges for all three platforms; fully automatic per-message capture. |
| D-2 | **Conduit as homeserver** | Single-binary + RocksDB; fits k3s resource budget; suitable for single-user homelab. |
| D-3 | **Conduit internet-exposed via Cloudflare Tunnel** | iPhone Element client and mautrix-imessage (Mac) both need HTTPS access. Tunnel is outbound-only, already in use for LobeHub. |
| D-4 | **`server_name = matrix.<domain>` (Option B, no `.well-known`)** | Immutable after first write; subdomain approach needs no delegation server. Matrix IDs: `@user:matrix.<domain>`. |
| D-5 | **`allow_federation = false`** | Eliminates entire class of federation CVEs including CVE-2025-49090. Bridges use local appservice API, not federation. |
| D-6 | **`allow_registration = false`** | Single-user server; admin created once via Conduit admin room. |
| D-7 | **mautrix-imessage on Mac (WebSocket outbound)** | Requires local iMessage DB access. No inbound port on Mac — bridge opens WebSocket to Conduit. |
| D-8 | **mautrix-whatsapp + signal on k3s** | Both use cloud protocols; no Mac dependency. |
| D-9 | **Modern pure-Go mautrix-signal (no signald sidecar)** | Simpler single-container deployment; legacy signald variant is harder to run on k3s. |
| D-10 | **Appservice registration YAMLs as k8s Secrets, mounted into Conduit** | Tokens are bridge-namespace admin credentials; never in ConfigMaps or source code. |
| D-11 | **whisper.cpp NOT currently running as HTTP service on flinker — needs resolution** | Smoke testing revealed no process listening on flinker:8081. The `rocm-llama-whisper` container exists but whisper.cpp is not started as an HTTP server. Options: (a) start whisper-server on flinker, (b) deploy ASR pod in k3s. Pending user decision. |
| D-12 | **Bot = regular Matrix user (not appservice)** | No registration.yaml or Conduit restart needed to add the bot; simpler for single-bot single-user deployment. |
| D-13 | **No E2E encryption in bridges for v1** | Single-user homelab rooms; E2E adds crypto-store complexity with no meaningful benefit. |
| D-14 | **Single Pulumi stack `apps/matrix`** | All components are tightly coupled (shared namespace, secrets, appservice tokens); follows existing monorepo pattern. |
| D-15 | **Only Conduit uses `createExposedWebApp`; others are raw k8s resources** | Bridges and bot have no internet exposure requirement. |
| D-16 | **Summarization via llama.cpp (qwen3.6-35b-a3b) — fully local** | llama.cpp confirmed working at flinker:8080 with model `qwen3.6-35b-a3b`. Model is a reasoning model (Qwen3); `max_tokens: 1000` required so it can finish thinking before emitting content. |
| D-17 | **LobeHub integration deferred to v2** | The bot's event loop is the natural injection point; no architectural change needed. |
| D-18 | **Bot must auto-join rooms via `InviteEvent` callback** | Without an invite handler the bot never joins any bridged room and cannot receive audio events. Registered alongside the `RoomMessageAudio` callback. |
| D-19 | **matrix-nio callbacks receive `(room, event)` — client injected via closure** | matrix-nio's `add_event_callback` always passes `(room, event)`. Client reference must be captured in a `lambda` closure; not passed as a positional argument. |
| D-20 | **Bot image must be built for `linux/amd64` (cluster arch)** | Mac builds produce `arm64` images. Use `docker buildx build --platform linux/amd64` for all pushes to GHCR. |
| D-21 | **nginx WebSocket upgrade headers required for Signal bridge provisioning** | Signal's QR linking flow uses a long-lived WebSocket. Without `proxy_http_version 1.1` + `Upgrade`/`Connection` headers in the nginx sidecar, the provisioning websocket drops mid-handshake causing "context canceled". Fixed by adding WebSocket proxy directives to the nginx ConfigMap. |
| D-22 | **`full_state=False` (default) in sync loop — never pass `full_state=True`** | `full_state=True` forces Conduit to return the complete room state on every sync cycle instead of incremental deltas. With many WhatsApp/Signal rooms this causes a CPU spin at 500m (100% of the 500m limit). The correct pattern: call `client.sync(timeout=30000)` with no `full_state` argument so matrix-nio uses the stored `next_batch` token for incremental updates. |
| D-23 | **Conduit media download requires authenticated MSC3916 endpoint** | `/_matrix/media/v3/download` (unauthenticated) returns 404 in Conduit v0.10+. The bot must use `/_matrix/client/v1/media/download/{server}/{mxc_id}` with `Authorization: Bearer <token>`. Fixed by replacing `client.download()` with a direct `aiohttp` GET to the authenticated endpoint. |
| D-24 | **Conduit PVC must be ≥20 Gi — WAL logs fill disk at 5 Gi** | RocksDB WAL log files (~57 MB each) accumulate rapidly with many bridged rooms. The original 5 Gi PVC reached 100% within ~34 h, causing all media uploads to fail with `IO error: No space left on device`, which left `filehash_metadata` inconsistent and made all media un-downloadable. PVC expanded to 20 Gi. |
| D-25 | **Transcription reply must use `m.notice` msgtype, not `m.text`** | Bridge bots relay any `m.text` message posted in a portal room back to the underlying platform (Signal/WhatsApp). The bot's transcript reply triggers a "Your message was not bridged" warning from the bridge bot because it tries and fails to deliver the reply to Signal. Using `m.notice` is the standard convention for bot/automated messages — bridges are expected to ignore notices. (tracked: homelab-apps-1.4.27) |
| D-26 | **LLM summarization fails silently — llama.cpp unreachable or timing out** | Bot logs show `llm_unavailable` with empty error string (bare `asyncio.TimeoutError` or connection refused). Transcript is posted but no summary. Root cause: llama.cpp at flinker:8080 may be idle/unloaded between calls. Fix options: increase timeout beyond 30s; pre-warm the model; or check flinker:8080 health before calling. (tracked: homelab-apps-1.4.28) |
| D-27 | **Auto-join via `RoomSpaceChildEvent` is incomplete — bridge must invite explicitly** | The `RoomSpaceChildEvent` watcher fires when the bot observes a new child added to a space it's already in. But for new contacts/conversations created after bot startup, the bridge creates a new portal room and adds it to the space; the bot may miss the event if it wasn't synced yet. The reliable fix is for the bridge appservice token to explicitly invite the bot to each new portal. (tracked: homelab-apps-1.4.26) |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WhatsApp bans account (unofficial web protocol) | Medium | High | Use physical phone as primary device; accept for personal use |
| `server_name` misconfigured (immutable after first write) | Low | Critical | Set `matrix.<domain>` before first run; verify before `pulumi up` |
| Appservice token mismatch (Conduit ↔ bridge) | Medium | High | Generate YAMLs first; store as Secrets; deploy Conduit after |
| Bot access token leaked via pod spec | Low | Medium | Stored as k8s Secret; passed via `secretKeyRef`, never plain env |
| Bot duplicates reply on reconnect | Medium | Low | In-memory dedup set; worst case is a double reply |
| iMessage bridge WebSocket drops | Medium | Medium | Auto-reconnect; iMessage DB is source of truth, no data loss |
| whisper.cpp unavailable on flinker | Low | High | Bot posts "transcription unavailable" error; whisper.cpp is monitored separately |

---

## Implementation Order

```
1. Namespace + bootstrap Secrets (appservice registration YAMLs)
2. Conduit (reads appservices/ from mounted Secrets)
3. mautrix-whatsapp + mautrix-signal (parallel)
4. transcription-bot (after bot user registered in Conduit admin room)
5. [out-of-band] mautrix-imessage on Mac
```

All steps 1–5 are managed by a single `pulumi up`. Step 6 is documented in
`apps/matrix/IMESSAGE_SETUP.md`.

---

## Ideation
<!-- beads-phase-id: homelab-apps-1.1 -->
### Tasks
<!-- beads-synced: 2026-05-21 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-1.1.1` Clarify internet exposure requirements for Conduit Matrix homeserver
- [x] `homelab-apps-1.1.2` Evaluate bridge options: mautrix-whatsapp, mautrix-signal, mautrix-imessage
- [x] `homelab-apps-1.1.3` Define voice transcription pipeline requirements
- [x] `homelab-apps-1.1.4` Define LobeHub integration requirements
- [x] `homelab-apps-1.1.5` Research Matrix homeserver attack surface when internet-exposed
- [x] `homelab-apps-1.1.6` Research Cloudflare Tunnel security properties for Matrix
- [x] `homelab-apps-1.1.7` Evaluate bridge credential and secret exposure risks
- [x] `homelab-apps-1.1.8` Define security requirements and mitigations

## Architecture
<!-- beads-phase-id: homelab-apps-1.2 -->
### Tasks
<!-- beads-synced: 2026-05-21 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-1.2.1` Define Pulumi project structure and app layout
- [x] `homelab-apps-1.2.2` Document Conduit homeserver deployment design
- [x] `homelab-apps-1.2.3` Document mautrix bridge deployment designs (whatsapp, signal, imessage)
- [x] `homelab-apps-1.2.4` Document Whisper service deployment design
- [x] `homelab-apps-1.2.5` Document voice-transcription-bot design (Python, matrix-nio)
- [x] `homelab-apps-1.2.6` Document Cloudflare Tunnel routing and .well-known delegation
- [x] `homelab-apps-1.2.7` Document data flows and persistence (storage, secrets, config)
- [x] `homelab-apps-1.2.8` Write architecture.md document

## Plan
<!-- beads-phase-id: homelab-apps-1.3 -->
### Tasks
<!-- beads-synced: 2026-05-21 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-1.3.1` Scaffold apps/matrix Pulumi project (package.json, tsconfig, Pulumi.yaml)
- [x] `homelab-apps-1.3.10` Add GitHub Actions CI workflow for matrix app
- [x] `homelab-apps-1.3.2` Implement Conduit homeserver Pulumi component (conduit.ts)
- [x] `homelab-apps-1.3.3` Implement mautrix-whatsapp Pulumi component (bridges.ts)
- [x] `homelab-apps-1.3.4` Implement mautrix-signal Pulumi component (bridges.ts)
- [x] `homelab-apps-1.3.5` Implement Whisper ASR service Pulumi component (whisper.ts)
- [x] `homelab-apps-1.3.6` Implement voice-transcription-bot Python application
- [x] `homelab-apps-1.3.7` Implement voice-transcription-bot Pulumi deployment (bot.ts)
- [x] `homelab-apps-1.3.8` Wire all components in index.ts + stack outputs
- [x] `homelab-apps-1.3.9` Write mautrix-imessage Mac setup instructions

## Code
<!-- beads-phase-id: homelab-apps-1.4 -->
### Tasks
<!-- beads-synced: 2026-05-21 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-1.4.1` Scaffold apps/matrix Pulumi project
- [x] `homelab-apps-1.4.10` Update docs: remove k8s Whisper deployment, use existing whisper.cpp on flinker:8081
- [x] `homelab-apps-1.4.11` Add pytest test suite for voice-transcription-bot
- [x] `homelab-apps-1.4.12` Add Pulumi preview dry-run to CI workflow
- [x] `homelab-apps-1.4.13` Add Docker build verification to CI
- [x] `homelab-apps-1.4.14` Write MANUAL_TESTING.md runbook with step-by-step verification procedures
- [x] `homelab-apps-1.4.15` Update CI: add PR trigger to Docker build workflow
- [x] `homelab-apps-1.4.16` Add llama.cpp summarization to bot (flinker:8080)
- [x] `homelab-apps-1.4.17` Document appservice token generation flow in architecture.md
- [x] `homelab-apps-1.4.18` Make bridge deployments conditional on token availability
- [x] `homelab-apps-1.4.19` Deploy Conduit + bot (first increment, no bridges)
- [x] `homelab-apps-1.4.2` Implement conduit.ts Pulumi component
- [x] `homelab-apps-1.4.20` Test Conduit accessibility (internal + external)
- [ ] `homelab-apps-1.4.21` Register bot user and test bot in direct Matrix room
- [x] `homelab-apps-1.4.22` Smoke test: test whisper.cpp + llama.cpp pipeline locally
- [x] `homelab-apps-1.4.23` Fix bot image: build and push to GHCR before deployment
- [x] `homelab-apps-1.4.3` Implement bridges.ts Pulumi component (whatsapp + signal)
- [x] `homelab-apps-1.4.4` Implement whisper.ts Pulumi component
- [x] `homelab-apps-1.4.5` Implement bot Python application
- [x] `homelab-apps-1.4.6` Implement bot.ts Pulumi deployment
- [x] `homelab-apps-1.4.7` Implement index.ts (main entrypoint + stack outputs)
- [x] `homelab-apps-1.4.8` Add GitHub Actions deploy-matrix.yml workflow
- [x] `homelab-apps-1.4.9` Write mautrix-imessage Mac setup runbook

## Finalize
<!-- beads-phase-id: homelab-apps-1.5 -->
### Tasks
<!-- beads-synced: 2026-05-21 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

