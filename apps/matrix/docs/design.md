<!--
DESIGN DOCUMENT TEMPLATE - FREESTYLE APPROACH

PURPOSE: Document design principles and standards in your preferred format.
NOTE: Technology stack decisions belong in the Architecture Document, not here.

DESIGN FOCUS AREAS:
✅ Design principles and patterns that guide implementation
✅ Naming conventions and coding standards
✅ Component design approaches and boundaries
✅ Data modeling and design principles
✅ Quality attribute design strategies (performance, security, etc.)
❌ NO Technology stack choices (goes in Architecture doc)
❌ NO Concrete class names or implementations
❌ NO Code snippets or method signatures

TIERED APPROACH SUGGESTION:
Start with core design principles, add complexity as project grows.
Consider organizing by: Essential → Core → Advanced → Specialized sections.

EXAMPLES:
✅ GOOD: "Repository pattern abstracts data access with clean interfaces"
✅ GOOD: "Components follow single responsibility principle with clear boundaries"
✅ GOOD: "Error handling uses custom exception hierarchy for different failure types"
❌ BAD: "PaymentController.processPayment() validates and processes transactions"
❌ BAD: "UserService extends BaseService and implements AuthService interface"

IMPORTANT: DO NOT REMOVE THIS COMMENT HOW TO USE THE TEMPLATE!
-->

# Design: Voice Message Transcription Pipeline

*See [architecture.md](./architecture.md) for system context and key technology decisions.*

---

## 1. Pulumi Module Structure

Each Pulumi source file owns exactly one subsystem (`conduit.ts`, `bridges.ts`, `whisper.ts`,
`bot.ts`). `index.ts` is a pure wiring layer: it reads config, instantiates modules, passes
outputs as inputs, and exports stack outputs. No resource definitions in `index.ts`.

Each module exports a single deploy function that accepts a typed options object and returns a
typed outputs object. Modules do not import from each other — all cross-module wiring is in
`index.ts`.

---

## 2. Naming Conventions

**Kubernetes resources** — pattern: `<component>` for the primary resource, `<component>-svc`
for services, `<component>-config` for ConfigMaps, `<component>-data` for PVCs.

**Labels** — all resources carry:
- `app.kubernetes.io/name: <component>`
- `app.kubernetes.io/part-of: matrix-pipeline`

**Pulumi stack** — project name `matrix`, stack `mrsimpson/matrix/dev`, config namespace `matrix:`.

**Bot image** — `ghcr.io/<owner>/voice-transcription-bot:<git-sha>`.

---

## 3. Secret Handling

Secrets read from Pulumi config use `requireSecret()` and are passed into pod specs via
`secretKeyRef` — never interpolated into plain strings or ConfigMaps.

Secrets bootstrapped outside Pulumi (appservice tokens, bot access token) are referenced in
Pulumi by name via a read-only `Secret.get(...)` call. The bootstrap steps are documented in
the operational runbook.

---

## 4. Bot Processing Model

The bot processes audio events sequentially (not in parallel) to avoid overloading the single
Whisper instance. An in-memory set deduplicates event IDs across reconnects.

Error handling tiers:
- Whisper unavailable → post "transcription unavailable" reply; continue.
- LLM error → post transcript only (no summary); continue.
- Matrix send failure → log and continue; do not crash.
- Invalid access token → crash immediately; let k8s restart.

All log output is structured JSON for `kubectl logs | jq` compatibility.

All bot replies use `msgtype: m.notice` so that mautrix bridges (Signal, WhatsApp) do not
attempt to forward them upstream, preventing spurious "not bridged" bridge warnings.

---

## 5. LLM Integration

Summarization uses the local llama.cpp inference server on flinker (not OpenRouter). The loaded
chat model is discovered dynamically at startup via `GET /v1/models` — the bot picks the first
model with `status.value = "loaded"` that is not an embeddings model (heuristic: no
`--embeddings` flag in model args). No `LLM_MODEL` env var is needed or accepted.

The summary prompt instructs the model to detect the transcript language and produce every
word of the response — including section headings — in that language. The structured output
format is: **TL;DR** (one sentence) + optional **Actions** section (only when explicit
call-to-actions exist) + **Key points** bullets. `max_tokens` is set to 2000 to accommodate
chain-of-thought reasoning models (e.g. Qwen3).

LLM timeout is 120 s (matching the Whisper timeout) to allow for KV-cache loading on large
models.

---

## 5. Security Posture

- Each pod gets its own `ServiceAccount` with `automountServiceAccountToken: false`.
- No pod has k8s API access (all cross-component communication is HTTP/Matrix SDK).
- Secrets mounted read-only; never in environment variable plain text for tokens.
- Namespace enforces `pod-security.kubernetes.io/enforce: restricted`.
