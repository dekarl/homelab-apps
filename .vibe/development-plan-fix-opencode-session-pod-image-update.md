# Development Plan: homelab-apps (fix/opencode-session-pod-image-update branch)

*Generated on 2026-06-04 by Vibe Feature MCP*
*Workflow: [bugfix](https://codemcp.github.io/workflows/workflows/bugfix)*

## Goal
Fix CI/CD pipeline so the deploy workflow is automatically triggered after the build workflow completes.

Root cause: The build workflow committed the updated `Pulumi.dev.yaml` to `main`, but GitHub's `GITHUB_TOKEN` does not trigger new workflow runs from commits made by another workflow (security measure to prevent recursive workflows). So the deploy workflow never ran with the new image tag.

## Key Decisions
- **Fix**: Add `actions: write` permission and a `Trigger deploy workflow` step to the build workflow that calls `gh workflow run deploy-opencode-router.yml --ref main` after updating `Pulumi.dev.yaml`. This explicitly dispatches the deploy workflow via the GitHub API instead of relying on a push-trigger chain.
- **Alternatives considered**: Using a `PAT` (Personal Access Token) for the `git push` would have triggered the deploy via the `push` event, but requires secrets management and a separate token. The `workflow_dispatch` approach is simpler and more explicit.
- **Edge case**: If the deploy workflow is already running from a parallel `push` event, the new dispatch will queue and run sequentially, picking up the latest config.

## Notes
- The manual deploy was triggered via `gh workflow run deploy-opencode-router.yml --ref main` to get the router onto `homelab-main.e63e765` in the interim.
- The build workflow also updates `:latest` tag on GHCR, but the deploy reads the specific tag from `Pulumi.dev.yaml`, so the commit + dispatch chain is the correct approach.

## Reproduce
<!-- beads-phase-id: homelab-apps-13.1 -->
### Tasks

*Tasks managed via `bd` CLI*

## Analyze
<!-- beads-phase-id: homelab-apps-13.2 -->
### Tasks

*Tasks managed via `bd` CLI*

## Fix
<!-- beads-phase-id: homelab-apps-13.3 -->
### Tasks

*Tasks managed via `bd` CLI*

## Verify
<!-- beads-phase-id: homelab-apps-13.4 -->
### Tasks

*Tasks managed via `bd` CLI*

## Finalize
<!-- beads-phase-id: homelab-apps-13.5 -->
### Tasks

*Tasks managed via `bd` CLI*



---
*This plan is maintained by the LLM and uses beads CLI for task management. Tool responses provide guidance on which bd commands to use for task management.*
