# Architecture: Voice Message Transcription & Unified Inbox

*Phase: Architecture — v1.1*

---

## 1. Problem & Context

The user receives voice messages on WhatsApp and Signal. These are fragmented across apps, are not
searchable, and require listening in full to understand. The goal is a unified, automated pipeline
that transcribes all voice messages and posts text summaries back inline — without any manual action
per message and without audio leaving the homelab.

### Constraints
- Single-node k3s homelab cluster ("flinker"); no cloud compute for audio
- Cloudflare Tunnel for internet exposure (outbound-only, no open inbound ports)
- Existing Pulumi + TypeScript pattern used for all k8s deployments
- whisper.cpp already running on k3s node (flinker:8081) for local audio transcription

---

## 2. System Context

```
iPhone (Element app)
       │ HTTPS
       │
       ▼
Cloudflare Tunnel ──────────► Conduit homeserver (k3s)
                                     │
                        ┌────────────┤
                        │            │            │
                  mautrix-       mautrix-     transcription-bot
                  whatsapp       signal             │
                        │            │              │
                   WhatsApp      Signal       whisper.cpp
                                              (flinker:8081)
```

- Conduit is internet-exposed via Cloudflare Tunnel.
- All k3s components are ClusterIP-only.
- whisper.cpp runs directly on the k3s node (`flinker:8081`); audio never leaves the homelab.
- iMessage bridge is out of scope: mautrix-imessage requires a dedicated Mac app and is not deployed.

---

## 3. Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | **Matrix as the ingestion layer** | Production-quality bridges exist for WhatsApp and Signal. Fully automatic per-message capture — no manual iOS Shortcuts sharing. |
| D-2 | **Conduit as homeserver** | Single-binary with embedded RocksDB. Far lighter than Synapse; fits k3s resource budget. Suitable for single-user homelab. |
| D-3 | **Conduit must be internet-exposed** | iPhone Matrix client (Element) needs direct HTTPS sync. Cloudflare Tunnel (already used by LobeHub) is the right path — no open inbound ports, DDoS protection, TLS managed by Cloudflare. |
| D-4 | **`server_name = matrix.<domain>` — Option B, no `.well-known` delegation** | `server_name` is permanently baked into Matrix IDs. Using the full subdomain (`matrix.<domain>`) means Conduit answers at its own name with no additional delegation server needed. Matrix IDs: `@user:matrix.<domain>`. |
| D-5 | **`allow_federation = false`** | This is a private single-user server with no need to federate. Disabling federation eliminates the entire class of federation CVEs — including the high-severity CVE-2025-49090 "Project Hydra" (August 2025). mautrix bridges use the local appservice API, not federation. |
| D-6 | **`allow_registration = false`** | Single-user server. Admin user created once via Conduit admin room at first boot. |
| D-7 | **iMessage bridge out of scope** | mautrix-imessage requires a dedicated Mac app with access to the local iMessage DB — it cannot run on k3s and has significant operational overhead. Dropped from v1. |
| D-8 | **mautrix-whatsapp + mautrix-signal run on k3s** | Both use network protocols (WhatsApp Web multi-device, Signal linked-device API). No Mac dependency. |
| D-9 | **Modern pure-Go mautrix-signal (no signald sidecar)** | mautrix-signal ≥ 0.6 is a pure-Go implementation. Single container, actively maintained. signald-based variant is legacy and harder to run on k3s. |
| D-10 | **Appservice registration YAMLs stored as k8s Secrets, mounted into Conduit** | Registration YAMLs contain `as_token` and `hs_token` — equivalent to bridge-namespace admin credentials. Never in ConfigMaps or source code. Mounted read-only into `/var/lib/conduit/appservices/`. |
| D-11 | **whisper.cpp already running on k3s node (flinker:8081); no k8s deployment** | Audio stays fully local (NFR-S1). whisper.cpp is already provisioned on the node; no additional k8s resources or PVC needed. Bot calls `http://flinker:8081/inference` directly. |
| D-12 | **Transcription bot = regular Matrix user (not appservice)** | No `registration.yaml` needed, no Conduit restart to add the bot. Python + matrix-nio. Bot user registered once via Conduit admin room; access token stored in k8s Secret. |
| D-13 | **No E2E encryption in bridges for v1** | Single-user homelab rooms. E2E adds crypto store complexity with no meaningful benefit. Can be enabled per-room later. |
| D-14 | **Single Pulumi stack `apps/matrix`** | All components share a namespace, secrets, and appservice tokens — tight coupling favours a single stack. Follows existing `apps/<name>` monorepo pattern. |
| D-15 | **Only Conduit uses `createExposedWebApp`; all others are raw k8s resources** | Bridges and the bot have no internet exposure requirement. Raw resources are simpler and avoid unnecessary ingress overhead. |
| D-16 | **No external summarization (OpenRouter) for v1** | The bot posts the raw transcript only. Summarization can be added later via LobeHub agent or local LLM. This keeps the stack minimal and avoids sending any data to external APIs. |
| D-17 | **LobeHub integration deferred to v2** | The bot's event loop is the natural injection point. No architectural change needed — adding a LobeHub API call is one extra step in the bot's event handler. |

---

## 4. Component Inventory

| Component | Type | Runtime | Image | Notes |
|-----------|------|---------|-------|-------|
| `conduit` | Matrix homeserver | k3s StatefulSet | `matrixconduit/matrix-conduit:<tag>` | Single-binary, RocksDB, 20 Gi PVC |
| `mautrix-whatsapp` | Bridge | k3s StatefulSet | `dock.mau.dev/mautrix/whatsapp:latest` | WA multi-device; 2 Gi PVC |
| `mautrix-signal` | Bridge | k3s StatefulSet | `dock.mau.dev/mautrix/signal:latest` | Signal linked-device; 2 Gi PVC |
| `transcription-bot` | Event bot | k3s Deployment | custom Python image | `ghcr.io/<owner>/voice-transcription-bot` |
| `whisper.cpp` | ASR engine | k3s node (flinker) | N/A (already running) | Port 8081; called by bot |

All k3s components live in namespace **`matrix`**.

---

## 5. Infrastructure & Connectivity

### Internet exposure
- **Conduit** is the only internet-facing component, routed via the existing Cloudflare Tunnel at `matrix.<domain>`.
- All other services are `ClusterIP` within the `matrix` namespace.

### Port reference

| Port | Component | Where | Access |
|------|-----------|-------|--------|
| 443  | Cloudflare edge → Conduit | Public | Internet |
| 6167 | Conduit pod | k3s | Tunnel only |
| 29318 | mautrix-whatsapp | k3s | ClusterIP |
| 29328 | mautrix-signal | k3s | ClusterIP |
| 8081 | whisper.cpp | k3s node (flinker) | Cluster-internal (bot only) |
### Storage

| Component | PVC name | Size | StorageClass | Contents |
|-----------|----------|------|--------------|---------|
| conduit | `conduit-data` | 20 Gi | longhorn-persistent | RocksDB Matrix event store + media |
| mautrix-whatsapp | `mautrix-whatsapp-data` | 2 Gi | longhorn-uncritical | Bridge DB, media cache |
| mautrix-signal | `mautrix-signal-data` | 2 Gi | longhorn-uncritical | Bridge DB, Signal device state |
| transcription-bot | `bot-data` | 500 Mi | longhorn-uncritical | matrix-nio session store |

### Resource budget (k3s node "flinker")

| Component | CPU request | Memory request |
|-----------|------------|----------------|
| Conduit | 50m | 128 Mi |
| mautrix-whatsapp | 50m | 128 Mi |
| mautrix-signal | 50m | 128 Mi |
| transcription-bot | 50m | 128 Mi |
| whisper.cpp (node) | — | — | Already running; not managed by this stack |
| **Total** | **~200m** | **~512 Mi** |

---

## 6. Secrets Inventory

| Secret name | Contents | How provisioned |
|------------|---------|----------------|
| `conduit-appservice-whatsapp` | bridge `registration.yaml` | Generated by bridge `--generate-registration`; applied manually |
| `conduit-appservice-signal` | bridge `registration.yaml` | Generated by bridge; applied manually |
| `mautrix-whatsapp-config` | `config.yaml` with `as_token`/`hs_token` | Pulumi (tokens from config secrets) |
| `mautrix-signal-config` | `config.yaml` with `as_token`/`hs_token` | Pulumi (tokens from config secrets) |
| `transcription-bot-credentials` | `BOT_ACCESS_TOKEN` | Bootstrap: register bot via Conduit admin room, then `kubectl create secret` |
| `conduit-admin` | `CONDUIT_ADMIN_TOKEN` | Pulumi config secret |
| `cloudflared-tunnel` | tunnel credential JSON | Existing; referenced by name |

---

## 7. Where Do The Tokens Come From?

A common source of confusion is where the various tokens and credentials originate.
Here is the complete picture:

### Appservice tokens (`as_token`, `hs_token`)

**Generated by the bridge binary itself.** Each mautrix bridge has a built-in command:

```bash
mautrix-whatsapp -g -c config.yaml   # writes registration.yaml
```

This generates a `registration.yaml` containing:
- `as_token` (appservice token) — random string, used by Conduit to authenticate the bridge
- `hs_token` (homeserver token) — random string, used by the bridge to authenticate to Conduit

These tokens are **not created by Pulumi, not stored in Pulumi ESC, and not manually invented**.
They are cryptographically random values generated by the bridge.

**Used in two places:**
1. **Bridge config** (`config.yaml`) — the bridge uses `hs_token` to prove its identity to Conduit
2. **Conduit appservices** — Conduit uses `as_token` to verify that incoming events are from the bridge

**The tokens must match exactly** between the bridge's `config.yaml` and Conduit's appservices directory.

### Bot access token (`BOT_ACCESS_TOKEN`)

**Generated by Conduit when you register the bot user.**

After Conduit is running, you create the bot user via the admin API:

```bash
curl -X POST "http://localhost:6167/_matrix/client/r0/register" \
  -d '{"username":"transcription-bot","password":"...","type":"m.login.password"}'
```

Then log in to get an access token:

```bash
curl -X POST "http://localhost:6167/_matrix/client/r0/login" \
  -d '{"type":"m.login.password","user":"transcription-bot","password":"..."}'
# Response: {"access_token": "syt_...", ...}
```

This `access_token` is saved to the k8s Secret `transcription-bot-credentials`.

### Conduit admin token (`CONDUIT_ADMIN_TOKEN`)

**Set manually by the operator** (you) via Pulumi config:

```bash
pulumi config set matrix:conduitAdminToken "<your-secret-admin-token>" --secret
```

This token is used for the Conduit admin API (user registration, etc.).

---

## 8. Deployment Bootstrap Order

The appservice chicken-and-egg problem (Conduit needs registration YAMLs before it starts; bridges
generate them before connecting) is resolved by the following sequence:

```
1. Generate registration YAMLs using bridge --generate-registration (no homeserver needed)
   → This creates as_token and hs_token for each bridge
2. kubectl create secret -n matrix conduit-appservice-whatsapp --from-file=registration.yaml
3. kubectl create secret -n matrix conduit-appservice-signal   --from-file=registration.yaml
4. pulumi up → Namespace, Conduit, bridges, bot
   → Pulumi reads as_token/hs_token from config secrets and injects into bridge config.yaml
5. Register bot user via Conduit admin room; save access token to k8s Secret
   kubectl create secret -n matrix generic transcription-bot-credentials \
     --from-literal=BOT_ACCESS_TOKEN=<token>
6. kubectl rollout restart deployment/transcription-bot -n matrix
```

---

## 9. Future: LobeHub Agent Integration (v2)

The `transcription-bot`'s event loop is the natural v2 injection point. After producing
the transcript, the bot can optionally forward it to a LobeHub AI agent for summarization,
categorization, or action extraction. No architectural changes needed — the bot simply
adds an extra HTTP call before posting the reply.

Required additions (all optional):
- `LOBEAGENT_URL` — internal ClusterIP of the LobeHub agent API
- `LOBEAGENT_ID` — agent identifier
- `LOBEHUB_API_KEY` — from Pulumi ESC

The v1 bot posts the raw transcript only; v2 can enrich it with agent-generated metadata.
