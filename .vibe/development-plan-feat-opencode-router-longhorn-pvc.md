# Development Plan: homelab-apps (feat/opencode-router-longhorn-pvc branch)

*Generated on 2026-06-03 by Vibe Feature MCP*
*Workflow: [epcc](https://codemcp.github.io/workflows/workflows/epcc)*

## Goal
Replace the `emptyDir` volume used for the opencode-router session archive (`/data/history`) with a real Longhorn persistent volume (PVC), so that archived session JSON files survive pod restarts and redeployments.

## Key Decisions
- Use `longhorn-persistent` storage class — user explicitly requested this; ensures archive history is durable and replicated
- Use `ReadWriteOnce` access mode — router runs as a single replica
- PVC size: `2Gi` — user confirmed this is sufficient for session JSON archive files
- PVC name: `code-history` (follows `<app>-<purpose>` convention)
- The `ARCHIVE_DIR` env var stays at `/data/history` — only the volume source changes from `emptyDir` to `persistentVolumeClaim`
- No new stack config key needed — size is small and fixed; can add `historyStorageSize` config later if needed
- `dependsOn: [ns]` for the PVC resource (standard pattern across all apps)

## Notes
- Current state: `extraVolumes` uses `emptyDir: {}` for `session-history` — data is lost on every pod restart
- Pattern reference: `apps/aftertouch/src/index.ts` and `apps/matrix/src/conduit.ts` show the standard PVC + `extraVolumes`/`extraVolumeMounts` pattern
- Available Longhorn storage classes in the cluster: `longhorn-uncritical` (used for non-critical app data), `longhorn-persistent` (used for databases)
- The `storageSize` config (currently `10Gi`) refers to the per-user **session workspace PVC** managed by the router at runtime — NOT the archive PVC

## Explore
<!-- beads-phase-id: homelab-apps-8.1 -->
### Tasks

*Tasks managed via `bd` CLI*

## Plan
<!-- beads-phase-id: homelab-apps-8.2 -->
### Tasks

*Tasks managed via `bd` CLI*

### Implementation Steps

1. **Add PVC resource** in `apps/opencode-router/src/index.ts`:
   - Create `new k8s.core.v1.PersistentVolumeClaim("code-history", { ... }, { dependsOn: [ns] })`
   - `storageClassName: "longhorn-persistent"`
   - `accessModes: ["ReadWriteOnce"]`
   - `storage: "2Gi"`
   - `namespace: ns.metadata.name`

2. **Update `extraVolumes`**: replace the `emptyDir: {}` entry for `session-history` with `persistentVolumeClaim: { claimName: "code-history" }`

3. **Keep `extraVolumeMounts` unchanged** — `/data/history` mount path stays the same

4. **Typecheck**: run `tsc --noEmit` in `apps/opencode-router/` and confirm 0 errors

5. **Commit** on branch `feat/opencode-router-longhorn-pvc`

## Code
<!-- beads-phase-id: homelab-apps-8.3 -->
### Tasks

*Tasks managed via `bd` CLI*

### Completed
- Added `historyPvc` (`k8s.core.v1.PersistentVolumeClaim`, `code-history`, `longhorn-persistent`, `2Gi`, `ReadWriteOnce`, `dependsOn: [ns]`) in section 6c of `index.ts`
- Replaced `emptyDir: {}` in `extraVolumes` with `persistentVolumeClaim: { claimName: "code-history" }`
- Added `historyPvc` to `dependsOn` of `createExposedWebApp`
- `tsc --noEmit` passes with 0 errors

## Commit
<!-- beads-phase-id: homelab-apps-8.4 -->
### Tasks

*Tasks managed via `bd` CLI*



---
*This plan is maintained by the LLM and uses beads CLI for task management. Tool responses provide guidance on which bd commands to use for task management.*
