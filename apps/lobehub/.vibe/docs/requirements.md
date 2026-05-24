# Requirements: Voice Message Transcription & Unified Inbox

## Problem Statement

Voice messages from WhatsApp and Signal are siloed in separate mobile apps.
Listening to them is disruptive, slow, and unsearchable. The user wants an automated pipeline
that intercepts voice messages from both platforms, transcribes and summarizes them,
and surfaces the result in context — without manual effort per message.
In a future phase, transcripts should be forwardable to a LobeHub AI agent.

---

## Functional Requirements

### FR-1: Message Ingestion
- **FR-1.1** The system MUST automatically receive voice messages from WhatsApp and Signal without requiring a manual "share" action per message.
- **FR-1.2** The system MUST preserve the original context (sender, platform, room/conversation) alongside each voice message.
- **FR-1.3** All three platform inboxes MUST be consolidated into a single stream (unified inbox).

### FR-2: Transcription
- **FR-2.1** The system MUST transcribe voice messages to text automatically upon arrival.
- **FR-2.2** Transcription MUST work offline (self-hosted), not depend on third-party cloud APIs.
- **FR-2.3** Transcription quality MUST be sufficient for everyday speech in common languages (English, German).

### FR-3: Summarization
- **FR-3.1** The system MUST generate a concise summary of each transcribed voice message.
- **FR-3.2** Summarization MUST use the existing OpenRouter API (already configured in the homelab stack) — no new provider needed.

### FR-4: Result Delivery
- **FR-4.1** Transcription + summary MUST be posted back as a reply in the same Matrix room/conversation where the voice message arrived — so context is preserved.
- **FR-4.2** The user MUST be able to read the reply using any standard Matrix client (e.g. Element, Fluffychat) on mobile and desktop.

### FR-5: Future — LobeHub Integration (out of scope for v1, but must be designed for)
- **FR-5.1** Transcripts SHOULD optionally be forwarded to a LobeHub agent via its API for further AI processing.

---

## Non-Functional Requirements

### Performance
- **NFR-P1** Transcription of a typical voice message (< 3 minutes) MUST complete within 60 seconds of arrival.
- **NFR-P2** The pipeline MUST handle at least 20 voice messages per day without degradation.

### Security

#### Threat Model
This is a **private single-user homeserver** — not a public Matrix service. The primary threats are:
1. **Unauthorized account access** — someone registers/logs in and reads your private messages
2. **Federation abuse** — other Matrix servers connecting to yours and probing/abusing it
3. **Bridge credential theft** — stolen WhatsApp/Signal session keys allowing message impersonation
4. **Audio/transcript data leak** — voice data or transcripts exfiltrated from the cluster
5. **Cluster pivot** — the exposed Matrix endpoint becoming a foothold into the homelab k3s cluster
6. **Matrix protocol-level attacks** — CVEs in federation state resolution (e.g. CVE-2025-49090, the 2025 "Project Hydra" state resolution vulnerabilities affecting all server implementations)

#### Security Requirements
- **NFR-S1** Voice message audio and transcripts MUST remain within the homelab — no external cloud storage.
- **NFR-S2** The Matrix homeserver MUST NOT allow public registration (`allow_registration = false`).
- **NFR-S3** All external HTTP endpoints MUST be served over TLS — Cloudflare Tunnel provides this with automatic certificate management.
- **NFR-S4** ~~mautrix-imessage (Mac-side bridge)~~ iMessage bridge is out of scope for v1.
- **NFR-S5** Federation MUST be disabled (`allow_federation = false`) — this is a private server, not a public federated node. This eliminates the entire class of federation-level CVEs (including CVE-2025-49090 and the 2025 "Project Hydra" state resolution vulnerabilities).
- **NFR-S6** The Conduit homeserver MUST run in its own Kubernetes namespace with a dedicated ServiceAccount and no cluster-admin access.
- **NFR-S7** Bridge appservice tokens (shared secrets between Conduit and each bridge) MUST be stored as Kubernetes Secrets, not in plaintext config.
- **NFR-S8** The Whisper transcription service MUST be ClusterIP only (no external ingress) — it is called by the bot, not exposed to the internet.
- **NFR-S9** The transcription bot MUST use a dedicated Matrix user with access only to bridged rooms — not a homeserver admin account.
- **NFR-S10** Cloudflare Tunnel acts as the sole ingress point — the k3s node itself must have no publicly routable IP / no open ports on the internet.

#### Key Security Properties of the Architecture

| Property | How it's addressed |
|----------|-------------------|
| No public registration | `allow_registration = false` in Conduit config |
| No federation attack surface | `allow_federation = false` — eliminates all federation CVEs |
| TLS everywhere | Cloudflare Tunnel terminates TLS; internal traffic is cluster-local |
| No open inbound ports on server | Cloudflare Tunnel uses outbound-only `cloudflared` daemon |
| DDoS protection | Cloudflare's network absorbs volumetric attacks before they reach the homelab |
| IP obscuring | Origin IP is never exposed — only Cloudflare's edge IPs are visible |
| Audio stays local | Whisper runs on-cluster; audio files never leave the homelab |
| Bridge secrets isolated | k8s Secrets, not in bridge config files on disk |
| Blast radius limited | Conduit namespace is isolated; pod security standards enforced |

#### Residual Risks (accepted)
- **WhatsApp ToS**: mautrix-whatsapp uses the WhatsApp Web multi-device protocol — Meta has been known to occasionally ban accounts using unofficial clients. Risk is low with a physical phone as the primary device.
- **Conduit beta status**: Conduit is labelled beta software. For a private single-user inbox this is acceptable; for a production service it would not be.
- **iMessage**: Out of scope for v1 — mautrix-imessage requires a dedicated Mac app.
- **OpenRouter for summarization**: Transcripts (text only, not audio) are sent to OpenRouter for summarization. Voice message content will leave the homelab as text. This is a deliberate trade-off — if unacceptable, summarization can be switched to the local flinker inference endpoint.

### Usability
- **NFR-U1** The unified inbox MUST be accessible from iPhone (a Matrix client app).
- **NFR-U2** No manual action required per voice message — the pipeline is fully automatic.
- **NFR-U3** The system MUST work even when the user's Mac is offline (WhatsApp and Signal bridges run on k3s, not the Mac).

### Reliability
- **NFR-R1** The homeserver and bridges MUST auto-restart on failure (k8s restart policies).
- **NFR-R2** Bridges auto-restart on failure; transient gaps in bridged messages are acceptable.

---

## Constraints

- **C-1** Infrastructure: k3s homelab cluster on a single node ("flinker"), exposed via Cloudflare Tunnel.
- **C-2** Internet exposure: Conduit Matrix homeserver MUST be exposed to the internet for federation (required by mautrix bridges to connect to their upstream services and for mobile Matrix clients to sync).
- **C-3** Domain: The homelab already owns a public domain exposed via Cloudflare Tunnel — Conduit can use a subdomain (e.g. `matrix.<domain>`).
- **C-4** iMessage bridge is out of scope — it requires a dedicated Mac app and is not deployed.
- **C-5** mautrix-whatsapp and mautrix-signal CAN run fully on k3s (they use WhatsApp Web protocol and Signal's linked-device API respectively — no Mac dependency).
- **C-6** Transcription: Whisper runs self-hosted on k3s. The same instance serves all bridges.
- **C-7** Budget: All services MUST run within the existing homelab node's resource envelope.

---

## Assumptions and Dependencies

| # | Assumption |
|---|-----------|
| A-1 | The user has a WhatsApp account on an active phone — required for mautrix-whatsapp (uses WhatsApp Web multi-device). |
| A-2 | The user has a Signal account on a phone that supports linked devices — required for mautrix-signal. |
| A-3 | ~~iMessage~~ Out of scope for v1. |
| A-4 | The homelab domain is already routed through Cloudflare Tunnel — Conduit can be added as a new subdomain with `createExposedWebApp`. |
| A-5 | The voice transcription bot is a new homelab app (Python/Go), deployed on k3s via the same Pulumi pattern. |
| A-6 | LobeHub API integration is a future phase — architecture must leave a clean integration point. |

---

## Out of Scope (v1)

- Automatic forwarding to LobeHub agents (FR-5)
- Notification push to phone (a Matrix client app provides this natively)
- Transcription of non-voice attachments (video, etc.)
- Multi-user / multi-account support
- WhatsApp group voice messages (deprioritized — behavior depends on bridge maturity)
