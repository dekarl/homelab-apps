# Development Plan: homelab-apps (feat/move-cloudflare-operator-to-homelab-apps branch)

*Generated on 2026-06-03 by Vibe Feature MCP*
*Workflow: [epcc](https://codemcp.github.io/workflows/workflows/epcc)*

## Goal
Move the opencode-cloudflare-operator source + build CI from the `opencode` repo into `homelab-apps`, and add `editor-` subdomain route support so that `https://editor-<hash>-oc.no-panic.org/` resolves correctly.

## Key Decisions

1. **Move operator source into `apps/opencode-router/cloudflare-operator/`**: Keeps the operator co-located with the infrastructure that deploys it, simplifying the CI/CD loop.
2. **Add editor route support to the operator**: The operator currently only knows about `<hash>-oc`, `attach-<hash>-oc`, and `<port>-<hash>-oc` routes. We will add `editor-<hash>-oc` routes that reuse the same Traefik IngressRoute pattern as main session routes (OAuth2-protected, forwarded to the router service on port 80).
3. **Reuse existing workflow patterns**: The new `build-cloudflare-operator.yml` workflow in `homelab-apps` will mirror the existing one from the `opencode` repo but target `apps/opencode-router/cloudflare-operator/` and auto-update `apps/opencode-router/Pulumi.dev.yaml`.
4. **No separate `editor` service needed**: Editor traffic is proxied by the router (port 3000) to the pod's editor sidecar (port 7681), just like main session traffic. The `editor-` subdomain only needs an IngressRoute + CF DNS/tunnel entry pointing at the router service, not a separate K8s Service.
5. **Add `EDITOR_IMAGE` and `EDITOR_ROUTE_PREFIX` to Pulumi stack**: The router needs to know the editor image to inject into session pods, and the operator needs the `editorRoutePrefix` env var.

## Notes

### Root cause of the bug
The `editor-7d3f20fbd03c-oc.no-panic.org` URL does not resolve because:
- The router (opencode-router application code) knows how to handle `editor-` subdomains and proxy to port 7681
- But the cloudflare-operator (which creates DNS + tunnel routes + Traefik IngressRoutes at runtime when session pods appear) has NO knowledge of `editor-` prefixes
- Therefore no Cloudflare DNS record, tunnel route, or IngressRoute is created for `editor-<hash>-oc.<domain>`

### Current architecture

| Component | Location |
|---|---|
| Cloudflare operator source | `opencode/deployment/opencode-cloudflare-operator/` |
| Operator build CI | `opencode/.github/workflows/build-cloudflare-operator.yml` |
| Pulumi stack (deploys operator as sidecar) | `homelab-apps/apps/opencode-router/src/index.ts` |
| Deploy CI | `homelab-apps/.github/workflows/deploy-opencode-router.yml` |

The operator build CI auto-commits the new image tag to `opencode/deployment/homelab/Pulumi.dev.yaml`, NOT `homelab-apps`.

### What the operator currently creates per session pod
1. Cloudflare DNS CNAME: `<hash>-oc.<domain>`
2. Cloudflare tunnel ingress route for `<hash>-oc.<domain>`
3. Traefik IngressRoute (app + signin) for `<hash>-oc.<domain>` → router service:80 with oauth2-chain middleware
4. Traefik IngressRoute (attach) for `attach-<hash>-oc.<domain>` → code-attach service:4096 (no oauth2)
5. Background poller for dev-server ports → creates per-port IngressRoutes (`<port>-<hash>-oc.<domain>`)

### What needs to be added
6. Cloudflare DNS CNAME: `editor-<hash>-oc.<domain>` (same tunnel CNAME)
7. Cloudflare tunnel ingress route for `editor-<hash>-oc.<domain>` (same router service)
8. Traefik IngressRoute (app + signin) for `editor-<hash>-oc.<domain>` → router service:80 with oauth2-chain middleware

### Files to create/modify in homelab-apps

**New files:**
- `apps/opencode-router/cloudflare-operator/package.json`
- `apps/opencode-router/cloudflare-operator/tsconfig.json`
- `apps/opencode-router/cloudflare-operator/vitest.config.ts`
- `apps/opencode-router/cloudflare-operator/Dockerfile`
- `apps/opencode-router/cloudflare-operator/.npmrc`
- `apps/opencode-router/cloudflare-operator/src/config.ts`
- `apps/opencode-router/cloudflare-operator/src/index.ts`
- `apps/opencode-router/cloudflare-operator/src/cloudflare.ts`
- `apps/opencode-router/cloudflare-operator/src/ingressroute.ts`
- `apps/opencode-router/cloudflare-operator/tests/setup.ts`
- `apps/opencode-router/cloudflare-operator/tests/operator.test.ts`
- `.github/workflows/build-cloudflare-operator.yml`

**Modified files:**
- `apps/opencode-router/src/index.ts` — add `editorRoutePrefix` env var to operator sidecar, add `EDITOR_IMAGE` to router env
- `apps/opencode-router/Pulumi.dev.yaml.example` — add `code:editorImage` config key
- `.github/workflows/deploy-opencode-router.yml` — add trigger paths for cloudflare-operator changes

## Explore
<!-- beads-phase-id: homelab-apps-6.1 -->
### Tasks

- [x] Read cloudflare-operator source code from opencode repo (homelab-apps-6.1.1)
- [x] Understand current homelab-apps opencode-router Pulumi stack (homelab-apps-6.1.2)
- [x] Identify missing editor route support in operator (homelab-apps-6.1.3)
- [x] Read existing build workflow and CI patterns (homelab-apps-6.1.4)

## Plan
<!-- beads-phase-id: homelab-apps-6.2 -->
### Tasks

- [x] Plan operator source code move structure (homelab-apps-6.2.1)
- [x] Plan editor route support architecture (homelab-apps-6.2.2)
- [x] Plan CI workflow integration strategy (homelab-apps-6.2.3)
- [x] Plan Pulumi stack and env var changes (homelab-apps-6.2.4)

### Implementation Strategy

#### Phase 1: Move operator source code
1. Copy `opencode/deployment/opencode-cloudflare-operator/src/` → `apps/opencode-router/cloudflare-operator/src/`
2. Copy build files (`package.json`, `tsconfig.json`, `Dockerfile`, `.npmrc`) into same directory
3. Adapt `package.json` name/dependencies for monorepo context
4. Ensure tests compile and pass (`vitest.config.ts`, `tests/setup.ts`, `tests/operator.test.ts`)

#### Phase 2: Add editor route support
In the operator, extend `interface Config` to include `editorRoutePrefix?: string`.
In `CloudflareOperator`:
- When handling `add` event for a session pod:
  - Create `editor-${hash}-oc.${domain}` DNS record + tunnel route + IngressRoute (same as main session route, but with `editorRoutePrefix`)
  - Set Traefik `rule` to `Host(`editor-${hash}-oc.${domain}`)`
  - Use same router service on port 80 as main session route
  - Add same oauth2-chain middleware
- When handling `delete` event: destroy all editor routes as well
- Ensure `editorRoutePrefix` is passed from Pulumi deployment environment variable

#### Phase 3: Integrate CI
1. Create `.github/workflows/build-cloudflare-operator.yml` in `homelab-apps`
   - Triggers: `push` to `feat/move-cloudflare-operator-to-homelab-apps`, `workflow_dispatch`
   - Builds image from `apps/opencode-router/cloudflare-operator/`
   - Auto-commits updated image tag to `apps/opencode-router/Pulumi.dev.yaml` (not `opencode` repo)
2. Update `.github/workflows/deploy-opencode-router.yml`
   - Add `paths` trigger for `apps/opencode-router/cloudflare-operator/**`
   - Ensure deploy runs when operator source changes

#### Phase 4: Update Pulumi deployment
1. In `apps/opencode-router/src/index.ts`:
   - Add `EDITOR_IMAGE` environment variable to router container spec (fetched from `cfg.editorImage`)
   - Pass `editorRoutePrefix` environment variable to cloudflare-operator container (value: `"editor-"`)
2. In `apps/opencode-router/Pulumi.dev.yaml.example`:
   - Add `code:editorImage: ghcr.io/mrsimpson/opencode-editor:0.1.0-main.a3c8a0c`
3. Ensure existing `cfOperatorImage` still references the image that will now be built from within this repo

#### Edge Cases
- What if `editorRoutePrefix` is not set? Operator should skip editor routes gracefully (backward compatible with existing stacks).
- What if the router does not handle `editor-` subdomains yet? That's a router concern, but the operator should still create the routes. The router already knows how to proxy `editor-` subdomains to port 7681.
- What if multiple session pods have overlapping editor hashes? Use same unique hash as main session, so collision risk is identical.

#### Dependencies
- Operator code → CI workflow → Pulumi stack update
- Router must know `EDITOR_IMAGE` before sessions are created (done at deployment time)

## Code
<!-- beads-phase-id: homelab-apps-6.3 -->
### Tasks

- [x] Copy operator source files to cloudflare-operator/ (homelab-apps-6.3.1)
- [x] Add editor route support in operator (homelab-apps-6.3.2)
- [x] Update Pulumi stack with editor env vars (homelab-apps-6.3.3)
- [x] Add build-cloudflare-operator CI workflow (homelab-apps-6.3.4)
- [x] Update deploy-opencode-router CI workflow triggers (homelab-apps-6.3.5)
- [x] Update Pulumi.dev.yaml.example with editorImage (homelab-apps-6.3.6)

### Implementation Summary

**Operator source code moved:**
- `apps/opencode-router/cloudflare-operator/` — complete operator source, tests, build config
- All 39 tests pass (35 existing + 4 new editor route tests)

**Editor route support added:**
- `config.ts`: Added `editorRoutePrefix` env var and `sessionEditorHostname()` helper
- `index.ts`: Added editor DNS record, tunnel route, and IngressRoute creation/deletion in pod lifecycle handlers
- Editor routes reuse existing `createIngressRoutes`/`deleteIngressRoutes` functions (same pattern as main session routes)

**Pulumi stack updated:**
- Added `code:editorImage` config (with default fallback)
- Added `EDITOR_IMAGE` env var to router container
- Added `EDITOR_ROUTE_PREFIX` env var to operator sidecar

**CI workflows:**
- New `.github/workflows/build-cloudflare-operator.yml` — builds operator image from `apps/opencode-router/cloudflare-operator/`, runs tests, and auto-updates `Pulumi.dev.yaml`
- Existing deploy workflow already covers operator changes via `apps/opencode-router/**` glob

## Commit
<!-- beads-phase-id: homelab-apps-6.4 -->
### Tasks

*Tasks managed via `bd` CLI*



---
*This plan is maintained by the LLM and uses beads CLI for task management. Tool responses provide guidance on which bd commands to use for tasks in the current phase.*
