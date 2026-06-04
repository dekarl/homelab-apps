# Development Plan: homelab-apps (feat/opencode-token-metrics branch)

*Generated on 2026-06-03 by Vibe Feature MCP*
*Workflow: [epcc](https://codemcp.github.io/workflows/workflows/epcc)*

## Goal

Expose per-user LLM token-consumption metrics from opencode sessions to the existing Victoria Metrics / Grafana stack. Each metric must carry a `user` label (GitHub email) so dashboards can filter by individual users.

## Key Decisions

### KD-1: Token data source — plugin `event` hook on `message.part.updated`

The opencode plugin API (`@opencode-ai/plugin` v1.14.48) exposes an `event` hook that receives every internal bus event. The `message.part.updated` event carries a `part` field; when `part.type === "step-finish"`, it contains the full token breakdown:

```ts
part.tokens: {
  input: number       // non-cached input tokens
  output: number      // output tokens
  reasoning: number   // reasoning tokens (o-series models)
  cache: { read: number, write: number }  // cache tokens
  total?: number
}
part.cost: number  // cost in USD (already calculated by opencode)
```

This fires once per LLM step (one step = one LLM call). A single user message may trigger multiple steps (tool-use loops), so metrics must be incremented per step.

### KD-2: User identity — `USER_EMAIL` env var injected by pod-manager

The **actual** router code is at `~/projects/privat/opencode-router` (not the upstream open-source repo). In `packages/router/src/pod-manager.ts`, the pod env block (lines ~883-894) injects:
- `PLAYWRIGHT_MCP_CDP_ENDPOINT`
- `OPENCODE_POD_SECRET`
- `OPENCODE_SESSION_HASH`
- `OPENCODE_ROUTER_URL` (conditional)
- `OPENCODE_ROUTER_EXTERNAL_DOMAIN` (conditional)

The `session.email` is available at pod creation time (used for PVC/pod annotations and `getUserSecretName()`) but is **not** injected as an env var into the session pod.

**Decision**: Add `{ name: "OPENCODE_USER_EMAIL", value: email }` to the env array in `pod-manager.ts` (in the `ensurePod` function, alongside `OPENCODE_SESSION_HASH`). The plugin reads `process.env.OPENCODE_USER_EMAIL` to tag all metrics with the `user` label.

**Note on config.ts**: The router's `config.ts` does not need changes — `email` is a per-session runtime value passed to `ensurePod()`, not a global config value.

**Alternative considered**: Read the email from a pod annotation at runtime. Rejected — plugins cannot query the Kubernetes API.

### KD-3: Metrics push — VictoriaMetrics `/api/v1/import/prometheus` endpoint (no Pushgateway needed)

VictoriaMetrics natively accepts Prometheus text-format metrics via `POST /api/v1/import/prometheus`. The plugin pushes metrics after each `step-finish` event using a simple `fetch()` call with Prometheus exposition format. This requires:

- A `VICTORIA_METRICS_URL` env var in the session pod (e.g. `http://victoria-metrics.monitoring.svc.cluster.local:8428`)
- No Pushgateway deployment needed

### KD-4: Token-metrics merged into the router plugin

The token-metrics logic was originally a separate plugin (ConfigMap key `token-metrics.ts` + jq registration step). It was merged into the existing router plugin (`packages/plugin/src/index.ts`) because:

- Both plugins run in the same process (session pods)
- Both need the same env vars (`OPENCODE_USER_EMAIL`, `VICTORIA_METRICS_URL`)
- A single plugin avoids two separate `jq` registration steps
- No ConfigMap entry needed — the merged plugin is baked into the Docker image at `/etc/opencode-plugin/index.ts`

The init script no longer has a jq step for token-metrics registration. The router plugin's existing jq step (line ~752) registers `/etc/opencode-plugin/index.ts` which now handles both session management AND token metrics.

The token-metrics code reads `VICTORIA_METRICS_URL` and `OPENCODE_USER_EMAIL` from `process.env` — both already injected by `pod-manager.ts`.

### KD-5: VictoriaMetrics is already deployed — in the `homelab` stack

VictoriaMetrics is deployed by the `../homelab` repo (`packages/stacks/observability/src/index.ts`) as a Helm release named `victoria-metrics` (chart: `victoria-metrics-single`, fullnameOverride: `victoria-metrics`) in the `observability` namespace.

Its **in-cluster push endpoint** is:
```
http://victoria-metrics-server.observability.svc.cluster.local:8428/api/v1/import/prometheus
```

This endpoint is reachable from any pod in the cluster (cross-namespace). Session pods in the `code` namespace can push metrics directly to it via `fetch()`.

**Decision**: No new deployment needed. The plugin reads `VICTORIA_METRICS_URL` from env and pushes to the existing VM instance. The URL is wired in from the Pulumi stack (`apps/opencode-router/src/index.ts`) and injected into session pods as an env var.

### KD-6: Grafana dashboard — shared PVC (homelab creates, Grafana reads; homelab-apps writes via sync Job)

Since we own both repos and both are deployed to the same k3s cluster, the cleanest cross-repo dashboard sharing approach is a **shared ReadWriteMany PVC** mounted:
- **Created by**: the homelab observability stack (same stack that deploys Grafana)
- **Read by**: Grafana in the homelab observability stack
- **Written to**: by a one-shot `Job` deployed from homelab-apps, which copies the dashboard JSON into the PVC

**Why RWX PVC over alternatives**:
| Option | Pros | Cons |
|--------|------|------|
| Copy JSON to homelab repo | Simple | Cross-repo manual step, breaks "source of truth" |
| Symlink between repos | Simple locally | Doesn't work in CI/CD (separate checkouts) |
| Cross-repo ConfigMap via StackReference | No extra infra | homelab-apps can't write to observability namespace ConfigMaps |
| **Shared RWX PVC** | Single source of truth, live updates, Grafana auto-reloads every 30s | Needs RWX support (Longhorn v1.7.2 ✓ has `sharemanagers.longhorn.io` CRD) |

**Longhorn RWX status**: Longhorn v1.7.2 is deployed and the `sharemanagers.longhorn.io` CRD exists. No existing RWX PVs — this will be the first, but the capability is present. RWX volumes use NFS via a share-manager pod (spawned on demand).

**Architecture**:
```
homelab Pulumi stack (packages/stacks/observability/src/index.ts)
  └─ PVC: grafana-app-dashboards (ReadWriteMany, observability namespace, longhorn-uncritical, 100Mi)
  └─ Grafana deployment: mounts PVC at /var/lib/grafana/dashboards/app
  └─ dashboard-provider ConfigMap: watches /var/lib/grafana/dashboards (recursive)

homelab-apps Pulumi stack (apps/opencode-router/src/index.ts)
  └─ ConfigMap: opencode-dashboards (carries dashboard JSON in observability namespace)
  └─ Job: opencode-dashboard-sync (copies JSON from ConfigMap to PVC on every deploy)
```

**PVC location**: Created in the `observability` namespace (where Grafana runs) by the **homelab** stack. This ensures the PVC exists before Grafana tries to mount it — no scheduling failures.

**Dashboard JSON location**: `apps/opencode-router/grafana/opencode-token-metrics.json` in homelab-apps (source of truth). The sync Job reads this JSON (embedded in a ConfigMap) and writes it to the shared PVC.

**Grafana auto-reload**: Grafana's dashboard provisioner already runs with `updateIntervalSeconds: 30` — new files appear without restart.

**Dashboard JSON datasource**: Uses `${DS_VICTORIAMETRICS}` (matching the existing pattern in `llama-cpp.json` and `homelab-infra.json`).

### KD-8: PVC created in homelab stack (not homelab-apps)

**Decision**: The shared RWX PVC is created by the homelab observability stack (`packages/stacks/observability/src/index.ts`), not by homelab-apps. This ensures:
1. **No scheduling race**: Grafana mounts the PVC at deployment time; it already exists
2. **Single responsibility**: Infrastructure PVCs live with the stack that deploys the consumer (Grafana)
3. **Clean dependency graph**: homelab-apps only writes to the PVC (via sync Job), doesn't need to create cross-namespace resources

**Implementation**:
- `packages/stacks/observability/src/index.ts`: Creates `grafana-app-dashboards` PVC, adds it to Grafana's `dependsOn`
- `packages/stacks/observability/src/dashboards/index.ts`: `createAppDashboardVolume()` returns the volume/volumeMount for Grafana
- `apps/opencode-router/src/index.ts`: ConfigMap `opencode-dashboards` + sync Job that writes to the existing PVC
- The sync Job references the PVC by name (`grafana-app-dashboards`); no Pulumi dependency needed since the PVC is managed by another stack

### KD-7: Metrics schema

Metric names follow Prometheus convention:

| Metric | Labels | Description |
|--------|--------|-------------|
| `opencode_tokens_input_total` | `user`, `model`, `provider`, `session` | Cumulative input tokens per step |
| `opencode_tokens_output_total` | `user`, `model`, `provider`, `session` | Cumulative output tokens per step |
| `opencode_tokens_cache_read_total` | `user`, `model`, `provider`, `session` | Cache read tokens |
| `opencode_tokens_cache_write_total` | `user`, `model`, `provider`, `session` | Cache write tokens |
| `opencode_cost_usd_total` | `user`, `model`, `provider`, `session` | Cost in USD |

All are counters pushed on each `step-finish` event.

### KD-9: RWX → RWO PVC (deployment fix)

The k3s node (`flinker`, Ubuntu 24.04) does **not** have `nfs-common` installed, which is required for Longhorn RWX volumes (they mount via NFS). The first deployment attempt failed with:

```
mount: bad option; for several filesystems (e.g. nfs, cifs) you might need a /sbin/mount.<type> helper program.
```

**Fix**: Changed the PVC access mode from `ReadWriteMany` to `ReadWriteOnce` in the homelab observability stack. On a single-node k3s cluster, RWO allows multiple pods on the same node to mount the volume concurrently (Longhorn supports this). The sync Job writes the dashboard JSON, then Grafana mounts and reads it.

**File changed**: `homelab/packages/stacks/observability/src/index.ts` (line ~396)

### KD-10: Missing Grafana volume mount (code bug)

The `createAppDashboardVolume()` function was added to `dashboards/index.ts` but was **never actually called** in the main `observability/src/index.ts`. Grafana's `extraVolumes`/`extraVolumeMounts` arrays were missing the `appDashboardVolume` entry.

**Fix**: Added `appDashboardVolume.volume` and `appDashboardVolume.volumeMount` to Grafana's `createExposedWebApp` call, and imported `createAppDashboardVolume`.

**Files changed**:
- `homelab/packages/stacks/observability/src/index.ts` (import + volume mount)
- `homelab/packages/stacks/observability/src/dashboards/index.ts` (already had the function)

### KD-11: `lost+found` permission warning (benign)

Longhorn creates a `lost+found` directory at the root of every new ext4 volume, owned by root with mode `drwx------`. Grafana's file provisioner (running as uid 472) logs an error when scanning the `/var/lib/grafana/dashboards/app` directory:

```
logger=provisioning.dashboard ... level=error msg="failed to search for dashboards" error="open .../lost+found: permission denied"
```

**Observation**: This error does **not** prevent the provisioner from loading the actual dashboard JSON file. Grafana skips the unreadable directory and continues scanning. After removing a duplicate file artifact (left over from a subPath experiment), the dashboard loaded cleanly on the next Grafana pod restart.

**Mitigation**: The sync Job now includes `rm -rf /output/dashboards` to clean up any subdirectory artifacts from previous subPath experiments.

### KD-12: Sync Job cleanup

Added `rm -rf /output/dashboards` to the sync Job command to prevent duplicate dashboard files when switching between mount strategies.

**File changed**: `apps/opencode-router/src/index.ts` (sync Job command)

### KD-13: Token-metrics merged into router plugin (replaces separate ConfigMap plugin)

Originally the token-metrics plugin was a separate plugin:
- ConfigMap key `token-metrics.ts` with inline TS source
- Second jq registration step in init script

Merged into `packages/plugin/src/index.ts` because:
- Both plugins run in the same session pod process
- Both need `OPENCODE_USER_EMAIL` + `VICTORIA_METRICS_URL` env vars
- Single plugin = one jq registration step (the existing router plugin step)
- No ConfigMap entry needed — baked into Docker image

**Files changed**:
- `packages/plugin/src/index.ts` — added `pushMetricsToVM()` function, called from `event` hook on `message.part.updated`
- `packages/router/src/pod-manager.ts` — removed token-metrics jq registration step
- `apps/opencode-router/src/index.ts` — removed `TOKEN_METRICS_PLUGIN_SOURCE` constant, removed `token-metrics.ts` ConfigMap key, removed `VICTORIA_METRICS_URL` from router deployment env

## Notes

### How the opencode plugin system works

- Plugins are TypeScript files loaded via their path in the `plugin` array of `opencode.json`
- They export a `{ server: Plugin }` object where `Plugin = async (input: PluginInput) => Promise<Hooks>`
- The `Hooks.event` callback receives every internal bus event (type `Event`)
- `message.part.updated` events have `properties.part` — when `part.type === "step-finish"`, tokens and cost are present
- Plugins run in the opencode server process (Bun) — `fetch()` and `process.env` are available

### How user identity flows

1. User authenticates via GitHub OAuth → `X-Auth-Request-Email` header set by oauth2-proxy
2. Router reads this header from every request
3. When a session pod is created: `session.email` is stored as `opencode.ai/user-email` annotation on the PVC and the pod
4. The pod-manager injects `OPENCODE_SESSION_HASH` and `OPENCODE_ROUTER_URL` as env vars into the session pod's `opencode` container
5. **Gap**: `USER_EMAIL` / `session.email` is NOT currently injected as an env var — needs to be added

### How the ConfigMap is mounted in session pods

```
ConfigMap: opencode-config-dir  →  mounted at /home/opencode/.opencode/ (readOnly)
Contents:
  opencode.json   ← dynamic model overrides (deep-merged with baked config by init container)
  .env            ← arbitrary env vars sourced at pod start (for WORKFLOW_AGENTS etc.)
```

The init script can inject additional files into this ConfigMap by extending the Pulumi `configMap.data`. Plugin source files can be added as ConfigMap entries and loaded by path.

### opencode-router-plugin pattern (reference implementation)

The existing `opencode-router-plugin` (source: `packages/opencode-router-plugin/src/index.ts`):
- Reads `OPENCODE_ROUTER_URL`, `OPENCODE_SESSION_HASH`, `OPENCODE_POD_SECRET` from env
- Uses `fetch()` to push events to the router's REST API
- Is loaded via absolute path `/etc/opencode-plugin/index.ts` injected into `opencode.json` by the init script

Our plugin follows this exact same pattern.

### How VictoriaMetrics push works

VictoriaMetrics natively accepts Prometheus text exposition format via:
```
POST http://victoria-metrics-server.observability.svc.cluster.local:8428/api/v1/import/prometheus
Content-Type: text/plain

opencode_tokens_input_total{user="alice@example.com",model="gpt-4o",provider="openai",session="abc123"} 1234
```
No Pushgateway needed. Cross-namespace access works — any pod in the cluster can reach `observability` namespace services.

### How the homelab observability stack loads dashboards

- `homelab/packages/stacks/observability/src/dashboards/index.ts` reads all `*.json` files from `src/dashboards/json/` at `pulumi up` time
- They are bundled into the `grafana-dashboards-custom` ConfigMap
- Grafana mounts it at `/var/lib/grafana/dashboards/custom/`
- The dashboard provisioner checks every 30s (`updateIntervalSeconds: 30`) — new files appear without Grafana restart
- Dashboard JSON uses `${DS_VICTORIAMETRICS}` as the datasource UID (matches the provisioned name)

### Relevant files

| File | Role |
|------|------|
| `~/projects/privat/digitaleraluhut/homelab-apps/apps/opencode-router/src/index.ts` | Pulumi stack — creates ConfigMap + session pod env |
| `~/projects/privat/opencode-router/packages/router/src/pod-manager.ts` | **Actual** router — injects env vars into session pods |
| `~/projects/privat/opencode-router/packages/router/src/config.ts` | Router config — shows all env vars (no VM URL yet) |
| `~/projects/privat/opencode-router/packages/plugin/src/index.ts` | Existing router plugin — reference implementation |
| `~/projects/privat/digitaleraluhut/homelab/packages/stacks/observability/src/index.ts` | VM deployment — service URL `victoria-metrics-server.observability.svc.cluster.local:8428` |
| `~/projects/privat/digitaleraluhut/homelab/packages/stacks/observability/src/dashboards/index.ts` | Dashboard provisioning — reads JSON files from `src/dashboards/json/` |
| `~/projects/privat/digitaleraluhut/homelab/packages/stacks/observability/src/dashboards/json/llama-cpp.json` | Example custom dashboard — datasource pattern to follow |
| `.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` | Plugin API types |
| `packages/opencode/src/session/message-v2.ts` (open-source) | `StepFinishPart` schema (lines 262-281) |

## Explore
<!-- beads-phase-id: homelab-apps-9.1 -->
### Tasks

*Tasks managed via `bd` CLI*

## Plan
<!-- beads-phase-id: homelab-apps-9.2 -->

### Implementation Overview

The work spans **3 repositories** and **7 files**:

```
homelab-apps (this repo)
  apps/opencode-router/src/index.ts          [Pulumi] Add victoriaMetricsUrl + plugin CM entry + PVC + sync Job
  apps/opencode-router/grafana/
    opencode-token-metrics.json              [NEW] Grafana dashboard JSON (source of truth)

opencode-router repo  (~/projects/privat/opencode-router)
  packages/router/src/config.ts             Add victoriaMetricsUrl config field
  packages/router/src/pod-manager.ts        (a) Add OPENCODE_USER_EMAIL + VICTORIA_METRICS_URL env vars
                                            (b) Add jq step to register token-metrics plugin in opencode.json

homelab repo  (~/projects/privat/digitaleraluhut/homelab)
  packages/stacks/observability/src/index.ts            Add shared PVC volume mount to Grafana
  packages/stacks/observability/src/dashboards/index.ts Add app-dashboards PVC volume alongside ConfigMaps
```

### Task 1: Token-Metrics Plugin (homelab-apps ConfigMap)

**File**: `apps/opencode-router/src/index.ts` (ConfigMap `data`)  
**New key**: `plugins/token-metrics.ts`

Plugin source (TypeScript, runs in Bun inside the opencode container):

```typescript
import type { Plugin } from "@opencode-ai/plugin"

const userEmail = process.env.OPENCODE_USER_EMAIL ?? "unknown"
const vmUrl = process.env.VICTORIA_METRICS_URL

const TokenMetricsPlugin: Plugin = async (_input) => {
  return {
    event: async ({ event }) => {
      if (!vmUrl) return
      const e = event as any
      if (e.type !== "message.part.updated") return
      const part = e.properties?.part
      if (part?.type !== "step-finish") return

      const tokens = part.tokens ?? {}
      const cost = part.cost ?? 0
      // model string: e.g. "anthropic/claude-sonnet-4-5" — split on "/"
      const modelRaw: string = part.modelID ?? part.model ?? "unknown"
      const [providerRaw, ...modelParts] = modelRaw.split("/")
      const provider = modelParts.length ? providerRaw : "unknown"
      const model = modelParts.length ? modelParts.join("/") : modelRaw
      const session: string = part.sessionID ?? e.properties?.sessionID ?? "unknown"

      const labels = `user="${userEmail}",model="${model}",provider="${provider}",session="${session}"`
      const lines = [
        `opencode_tokens_input_total{${labels}} ${tokens.input ?? 0}`,
        `opencode_tokens_output_total{${labels}} ${tokens.output ?? 0}`,
        `opencode_tokens_cache_read_total{${labels}} ${tokens.cache?.read ?? 0}`,
        `opencode_tokens_cache_write_total{${labels}} ${tokens.cache?.write ?? 0}`,
        `opencode_cost_usd_total{${labels}} ${cost}`,
      ].join("\n")

      try {
        await fetch(`${vmUrl}/api/v1/import/prometheus`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: lines,
        })
      } catch (err) {
        console.warn("token-metrics-plugin: failed to push metrics:", err)
      }
    },
  }
}

export default { id: "token-metrics", server: TokenMetricsPlugin }
```

**Key design choices**:
- Non-fatal: `fetch` failures are logged as warnings, never thrown
- Only runs when `VICTORIA_METRICS_URL` is set (safe in local dev without VM)
- Uses `step-finish` part type — fires once per LLM call (handles tool-use loops correctly)
- model/provider parsing: splits on first `/` in modelID (e.g. `openrouter/gpt-4o` → provider=`openrouter`, model=`gpt-4o`)

### Task 2: ConfigMap init-script jq step (pod-manager.ts)

**File**: `~/projects/privat/opencode-router/packages/router/src/pod-manager.ts`  
**Location**: After the existing router-plugin jq step (line ~752-754)

Add this block to `initScript` array (after the router plugin jq block):

```typescript
// --- ensure token-metrics plugin is always in the plugin list (idempotent) ---
`if command -v jq >/dev/null 2>&1 && [ -f /home/opencode/.config/opencode/opencode.json ]; then`,
`  cfg=/home/opencode/.config/opencode/opencode.json`,
`  jq_filter='.plugin = ((.plugin // []) | if any(. == "/home/opencode/.opencode/token-metrics.ts") then . else . + ["/home/opencode/.opencode/token-metrics.ts"] end)'`,
`  tmp=$(jq "$jq_filter" "$cfg") && echo "$tmp" > "$cfg"`,
`fi`,
```

Note: path is `/home/opencode/.opencode/token-metrics.ts` — flat in the ConfigMap mount (no subdirectory), because ConfigMap keys cannot contain `/`.

### Task 3: Env vars in session pod (pod-manager.ts)

**File**: `~/projects/privat/opencode-router/packages/router/src/pod-manager.ts`  
**Location**: `env` array in `ensurePod()` (line ~883-894)

Add two new entries after `OPENCODE_SESSION_HASH`:

```typescript
{ name: "OPENCODE_USER_EMAIL", value: email },
...(config.victoriaMetricsUrl ? [{ name: "VICTORIA_METRICS_URL", value: config.victoriaMetricsUrl }] : []),
```

Note: `email` is destructured from `session` at line 704: `const { repoUrl, branch, sourceBranch, email } = session`

### Task 4: config.ts — add victoriaMetricsUrl

**File**: `~/projects/privat/opencode-router/packages/router/src/config.ts`

Add after `opencodeRouterExternalDomain`:

```typescript
/**
 * In-cluster URL for pushing token metrics to VictoriaMetrics.
 * When set, session pods push per-step token usage to this endpoint.
 * Example: VICTORIA_METRICS_URL=http://victoria-metrics-server.observability.svc.cluster.local:8428
 */
victoriaMetricsUrl: process.env.VICTORIA_METRICS_URL,
```

### Task 5: Pulumi stack — wire VICTORIA_METRICS_URL into router env

**File**: `apps/opencode-router/src/index.ts`

Two changes:
1. Read from stack config (optional):
```typescript
const victoriaMetricsUrl = cfg.get("victoriaMetricsUrl") 
  ?? "http://victoria-metrics-server.observability.svc.cluster.local:8428"
```

2. Add to router deployment env array (alongside other env vars):
```typescript
{ name: "VICTORIA_METRICS_URL", value: victoriaMetricsUrl },
```

3. Add plugin source to ConfigMap `data`:
```typescript
"plugins/token-metrics.ts": TOKEN_METRICS_PLUGIN_SOURCE, // inline TS string
```

**Note on CM structure**: The ConfigMap already contains `opencode.json` and `.env`. We add a new key `token-metrics.ts` (ConfigMap keys must be alphanumeric, `-`, `_`, or `.` — slashes are NOT allowed per Kubernetes spec). The file is mounted flat at `/home/opencode/.opencode/token-metrics.ts`.

**IMPORTANT — key naming constraint**: Kubernetes ConfigMap keys only allow `[a-zA-Z0-9._-]`. Forward slashes are forbidden. So the key must be `token-metrics.ts` (not `plugins/token-metrics.ts`), and the plugin path registered in `opencode.json` must be `/home/opencode/.opencode/token-metrics.ts`.

### Task 6: Grafana Dashboard JSON

**File**: `apps/opencode-router/grafana/opencode-token-metrics.json` (source of truth in homelab-apps)

Dashboard panels:

| Panel | Type | Query |
|-------|------|-------|
| Total Input Tokens | Time series | `sum by (user) (increase(opencode_tokens_input_total[1h]))` |
| Total Output Tokens | Time series | `sum by (user) (increase(opencode_tokens_output_total[1h]))` |
| Cache Hit Rate | Stat | `sum(rate(opencode_tokens_cache_read_total[5m])) / sum(rate(opencode_tokens_input_total[5m]))` |
| Cost This Hour (per user) | Bar gauge | `sum by (user) (increase(opencode_cost_usd_total[1h]))` |
| Cost Today (total) | Stat | `sum(increase(opencode_cost_usd_total[24h]))` |
| Tokens by Model | Time series | `sum by (model) (rate(opencode_tokens_input_total[5m]) + rate(opencode_tokens_output_total[5m]))` |
| Active Sessions | Stat | `count(count by (session) (opencode_tokens_input_total))` |

All panels use `datasource: { type: "prometheus", uid": "${DS_VICTORIAMETRICS}" }`.

### Task 7: Shared PVC + dashboard sync Job (homelab-apps Pulumi stack)

**File**: `apps/opencode-router/src/index.ts`

Three additions:

**A. ConfigMap holding dashboard JSON** (referenced by the sync Job):
```typescript
const dashboardConfigMap = new k8s.core.v1.ConfigMap("opencode-dashboards-cm", {
  metadata: { name: "opencode-dashboards", namespace: "observability" },
  data: { "opencode-token-metrics.json": fs.readFileSync("./grafana/opencode-token-metrics.json", "utf-8") },
}, { dependsOn: [observabilityNs] }) // namespace must pre-exist
```

**B. Shared PVC** (RWX, in `observability` namespace):
```typescript
const dashboardPvc = new k8s.core.v1.PersistentVolumeClaim("opencode-dashboards-pvc", {
  metadata: { name: "grafana-app-dashboards", namespace: "observability" },
  spec: {
    accessModes: ["ReadWriteMany"],
    storageClassName: "longhorn-uncritical",
    resources: { requests: { storage: "100Mi" } },
  },
})
```

**C. Sync Job** (runs on every `pulumi up`, copies JSON to PVC):
```typescript
const dashboardSyncJob = new k8s.batch.v1.Job("opencode-dashboard-sync", {
  metadata: {
    name: `opencode-dashboard-sync-${Date.now()}`,  // force re-run on each deploy
    namespace: "observability",
  },
  spec: {
    ttlSecondsAfterFinished: 300,
    template: {
      spec: {
        restartPolicy: "OnFailure",
        containers: [{
          name: "sync",
          image: "busybox:1.36",
          command: ["sh", "-c", "cp /dashboards/opencode-token-metrics.json /output/opencode-token-metrics.json"],
          volumeMounts: [
            { name: "dashboards-src", mountPath: "/dashboards" },
            { name: "dashboards-out", mountPath: "/output" },
          ],
        }],
        volumes: [
          { name: "dashboards-src", configMap: { name: "opencode-dashboards" } },
          { name: "dashboards-out", persistentVolumeClaim: { claimName: "grafana-app-dashboards" } },
        ],
      },
    },
  },
}, { dependsOn: [dashboardConfigMap, dashboardPvc] })
```

**Note**: The Job uses a timestamp-based name to force a new Job on each `pulumi up` (Kubernetes Jobs are immutable once created). `ttlSecondsAfterFinished: 300` cleans it up after 5 minutes.

**Note**: The homelab-apps Pulumi stack creates resources in the `observability` namespace. It does not need the `observability` namespace to be declared in homelab-apps — the namespace already exists (created by the homelab stack). We reference it by name only.

### Task 8: Grafana PVC volume mount (homelab Pulumi stack)

**File**: `~/projects/privat/digitaleraluhut/homelab/packages/stacks/observability/src/dashboards/index.ts`

Add a new exported function or extend `createDashboardConfigMaps` to also return a PVC-based volume:

```typescript
export function createAppDashboardVolume(): DashboardVolume {
  return {
    volume: {
      name: "dashboards-app",
      persistentVolumeClaim: { claimName: "grafana-app-dashboards" },
    },
    volumeMount: {
      name: "dashboards-app",
      mountPath: "/var/lib/grafana/dashboards/app",
      readOnly: true,
    },
  }
}
```

**File**: `~/projects/privat/digitaleraluhut/homelab/packages/stacks/observability/src/index.ts`

Add the PVC volume to Grafana's `extraVolumes` / `extraVolumeMounts` (alongside the ConfigMap-based ones):

```typescript
const appDashboardVolume = createAppDashboardVolume()

// In grafana createExposedWebApp call:
extraVolumes: [
  ...dashboardVolumes.map((d) => d.volume),
  appDashboardVolume.volume,   // NEW
],
extraVolumeMounts: [
  ...dashboardVolumes.map((d) => d.volumeMount),
  appDashboardVolume.volumeMount,  // NEW
],
```

The Grafana dashboard provider already watches `/var/lib/grafana/dashboards` recursively — the `app/` subdirectory will be picked up automatically within 30s.

### Task 9: Pulumi.dev.yaml update

**File**: `apps/opencode-router/Pulumi.dev.yaml`

Add (optional — has sensible default):
```yaml
config:
  code:victoriaMetricsUrl: "http://victoria-metrics-server.observability.svc.cluster.local:8428"
```

### Deployment Order

1. **Deploy homelab stack first** — this creates the `grafana-app-dashboards` PVC in the `observability` namespace and mounts it into Grafana
2. **Build + push opencode-router Docker image** — includes the updated `config.ts` and `pod-manager.ts`
3. **Deploy homelab-apps stack** — this creates the ConfigMap with the plugin source, the sync Job writes dashboard JSON to the PVC, and the router deployment gets `VICTORIA_METRICS_URL`

### Dependency Order for Code Phase

1. `apps/opencode-router/grafana/opencode-token-metrics.json` — dashboard JSON (no deps, create first)
2. `config.ts` in opencode-router — add `victoriaMetricsUrl` (no deps)
3. `pod-manager.ts` env vars — add `OPENCODE_USER_EMAIL` + `VICTORIA_METRICS_URL` (depends on #2)
4. `pod-manager.ts` init script — add token-metrics plugin jq step (independent of #3)
5. `apps/opencode-router/src/index.ts` — ConfigMap plugin entry + sync Job + router env (depends on #1)
6. `homelab/packages/stacks/observability/src/index.ts` — create PVC + wire into Grafana (independent)
7. `homelab/packages/stacks/observability/src/dashboards/index.ts` — `createAppDashboardVolume()` (independent)

### Edge Cases Considered

| Case | Handling |
|------|----------|
| `VICTORIA_METRICS_URL` not set | Plugin returns early, no-op. Safe for local dev. |
| VM unreachable (network error) | `fetch()` wrapped in try/catch, error logged as warning |
| `part.modelID` is undefined | Defaults to `"unknown"` |
| `part.tokens` is undefined/null | `tokens.input ?? 0` — all zeroes pushed (still valid) |
| `part.cost` is undefined | Defaults to `0` |
| `OPENCODE_USER_EMAIL` not set | Defaults to `"unknown"` — metric still pushed |
| ConfigMap key naming | Keys must be `[a-zA-Z0-9._-]` only — use `token-metrics.ts` as key (no `/`) |
| Plugin file on readOnly mount | Plugin is read-only source; opencode reads it, doesn't write |
| Multiple steps per user message | Each step-finish pushes independently — counters accumulate correctly |
| RWX PVC first-time provisioning | Longhorn spawns a share-manager pod on first mount — may take ~30s. Job has `restartPolicy: OnFailure` to retry. |
| Grafana starts before PVC has content | Empty directory is valid — provisioner finds no files, shows no app dashboards. Reconciles within 30s of sync Job completion. |
| `pulumi up` re-run (Job already exists) | Timestamp-based Job name ensures a new Job is always created. Old Job cleaned up via `ttlSecondsAfterFinished: 300`. |
| homelab-apps deploys before homelab | PVC is created in `observability` namespace. Namespace must pre-exist (created by homelab stack). Deploy homelab first. |
| PVC exists but Grafana not yet mounting it | New dashboard files appear on next Grafana pod restart or within 30s via provisioner hot-reload. |

### Tasks

*Tasks managed via `bd` CLI*

## Code
<!-- beads-phase-id: homelab-apps-9.3 -->
### Tasks

*Tasks managed via `bd` CLI*

## Commit
<!-- beads-phase-id: homelab-apps-9.4 -->
### Tasks

*Tasks managed via `bd` CLI*



---
*This plan is maintained by the LLM and uses beads CLI for task management. Tool responses provide guidance on which bd commands to use for task management.*
