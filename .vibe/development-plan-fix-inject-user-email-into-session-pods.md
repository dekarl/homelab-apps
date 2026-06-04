# Development Plan: homelab-apps (fix/inject-user-email-into-session-pods branch)

*Generated on 2026-06-04 by Vibe Feature MCP*
*Workflow: [epcc](https://codemcp.github.io/workflows/workflows/epcc)*

## Goal

Fix the `user` label in token metrics (currently `"unknown"`) by injecting `OPENCODE_USER_EMAIL` into session pods via the opencode-router. Additionally ensure `VICTORIA_METRICS_URL` is passed correctly. Then deploy the full chain so that metrics in VictoriaMetrics carry the real GitHub email as `user` label.

## Key Decisions

### KD-1: WIP changes are already correct

The diff in `~/projects/privat/opencode-router` (branch `fix/inject-user-email-into-session-pods`) contains exactly what is needed:
- `packages/router/src/pod-manager.ts`: adds `{ name: "OPENCODE_USER_EMAIL", value: email }` and `{ name: "VICTORIA_METRICS_URL", value: config.victoriaMetricsUrl }` to the session pod's `env:[]`
- `packages/router/src/config.ts`: adds `victoriaMetricsUrl: process.env.VICTORIA_METRICS_URL` to the config object
- `packages/plugin/src/index.ts`: token-metrics push logic (already copied to homelab-apps docker image — but keeping in sync here is good practice)

### KD-2: VICTORIA_METRICS_URL is already in session pods (via .env file sourcing)

`VICTORIA_METRICS_URL` is set in `Pulumi.dev.yaml` as `code:podEnv` and ends up in the pod's ConfigMap-mounted `.env` file at `/home/opencode/.opencode/.env`. The init script sources it. However, the WIP change **also** injects it as a direct Pod env var (via `config.victoriaMetricsUrl`). This is intentional: the plugin reads `process.env.VICTORIA_METRICS_URL` at process start — before the init script runs — so a direct env var is more reliable than a sourced .env file.

For this to work, `VICTORIA_METRICS_URL` must be set in the **router deployment's** env. It is currently in `Pulumi.dev.yaml` as `code:podEnv` (injected into session pods via .env), but NOT as a direct env var on the router pod. The Pulumi stack must also set `VICTORIA_METRICS_URL` on the router deployment, or the router must read it from its own env when creating session pods.

**Resolution**: `config.victoriaMetricsUrl = process.env.VICTORIA_METRICS_URL` in `config.ts`. The router deployment needs `VICTORIA_METRICS_URL` in its env. This is wired in `apps/opencode-router/src/index.ts` — needs a check.

### KD-3: Deploy chain (fully automatic after merge to main)

```
PR merge → main (mrsimpson/opencode-router, branch: fix/inject-user-email-into-session-pods)
  → build-image.yml builds ghcr.io/mrsimpson/opencode-router:<tag>
  → trigger-deploy job dispatches deploy-opencode-router.yml in digitaleraluhut/homelab-apps
     (via HOMELAB_APPS_PAT — confirmed present)
  → deploy-opencode-router.yml runs pulumi up with new routerImage
  → new router pod starts → new session pods get OPENCODE_USER_EMAIL + VICTORIA_METRICS_URL
```

HOMELAB_APPS_PAT is confirmed configured in mrsimpson/opencode-router secrets.

### KD-4: plugin/src/index.ts changes stay in both repos

The token-metrics logic in `packages/plugin/src/index.ts` (opencode-router repo) should be committed alongside pod-manager + config changes. Even though the running plugin is the one baked into `ghcr.io/digitaleraluhut/opencode` (from homelab-apps), keeping the source in the router repo maintains a single source of truth for review and future changes.

### KD-5: VICTORIA_METRICS_URL on the router pod

Checking `apps/opencode-router/src/index.ts`: the router deployment currently does NOT set `VICTORIA_METRICS_URL` as a direct env var. The `podEnv` ConfigMap only wires it into session pods via `.env`. For `config.victoriaMetricsUrl` to work, the router pod itself needs `VICTORIA_METRICS_URL` in its env.

**Options**:
1. Add `VICTORIA_METRICS_URL` to the router deployment env in `apps/opencode-router/src/index.ts` (Pulumi)
2. Read it from `Pulumi.dev.yaml` config (like `podEnv`) and inject via Pulumi

Option 1 is cleanest. The value is already available as a Pulumi config string.

## Notes

- The `user` label is `"unknown"` because `OPENCODE_USER_EMAIL` was never injected into session pods — the pod-manager change was never committed
- The `.env` sourcing happens in the init script of the session pod, which runs before opencode starts — BUT the plugin reads `process.env` at module load time, which is after the init script. So `.env` sourcing IS sufficient for `VICTORIA_METRICS_URL`. The direct env var injection is a belt-and-suspenders approach.
- `OPENCODE_USER_EMAIL` cannot come from `.env` (it's per-session, not a global config value) — it must be a direct pod env var.
- Model/provider labels are also `"unknown"` for the flinker local model — this is a separate issue, may need investigation of the event payload format.

### KD-20: StepFinishPart has no model field — use chat.message hook instead

The `StepFinishPart` SDK type (`@opencode-ai/sdk`) has: `id`, `sessionID`, `messageID`, `type`, `reason`, `cost`, `tokens`. **No model field.** This explains why model/provider were always "unknown".

The `chat.message` plugin hook provides `model.providerID` and `model.modelID`. Solution: cache model info per `messageID` in a Map when `chat.message` fires, then look it up when a `step-finish` part arrives for that `messageID`.

Commit: `5150179` (fix(opencode-plugin): get model/provider from chat.message hook for token metrics)

### KD-21: Metrics ARE in VictoriaMetrics but instant-query returns empty without time param

`/api/v1/query` without `?time=now` returns empty for stale time series. Use `?time=now` or `?start=<timestamp>` in Grafana dashboards to ensure recent data shows. Alternatively, `label/__name__/values` confirms series existence.

### KD-22: user label confirmed working

`opencode_tokens_input_total{user="github@beimir.net", session="...", model="unknown", provider="unknown"}` confirmed in VictoriaMetrics. After model fix (KD-20), model/provider will be populated for new sessions.

## Deploy chain status (2026-06-04)
- opencode image: `ghcr.io/digitaleraluhut/opencode:homelab-main.5150179` — has chat.message hook fix
- opencode-router image: `ghcr.io/mrsimpson/opencode-router:0.0.1-main.681e3b9` — injects OPENCODE_USER_EMAIL + VICTORIA_METRICS_URL into session pods
- router deployment: VICTORIA_METRICS_URL set as direct env var ✅
- All deployed to cluster ✅

## Explore
<!-- beads-phase-id: homelab-apps-10.1 -->
### Tasks

*Tasks managed via `bd` CLI*

## Plan
<!-- beads-phase-id: homelab-apps-10.2 -->
### Tasks

*Tasks managed via `bd` CLI*

## Code
<!-- beads-phase-id: homelab-apps-10.3 -->
### Tasks

*Tasks managed via `bd` CLI*

## Commit
<!-- beads-phase-id: homelab-apps-10.4 -->
### Tasks

*Tasks managed via `bd` CLI*



---
*This plan is maintained by the LLM and uses beads CLI for task management. Tool responses provide guidance on which bd commands to use for task management.*
