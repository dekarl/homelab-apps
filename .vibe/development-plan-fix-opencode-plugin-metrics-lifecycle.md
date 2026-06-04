# Development Plan: homelab-apps (fix/opencode-plugin-metrics-lifecycle branch)

*Generated on 2026-06-04 by Vibe Feature MCP*
*Workflow: [bugfix](https://codemcp.github.io/workflows/workflows/bugfix)*

## Goal
Fix token metrics (user/model/provider labels) by switching from step-finish to message.updated event — works for ALL providers.

## Key Decisions
- **KD-24**: `message.updated` (role=assistant) is the reliable event for token metrics. It carries `tokens`, `cost`, `modelID` & `providerID` directly on the message object — no `chat.message` cache needed. Fires for ALL providers, including flinker which never emits `step-finish`.

## Notes
*Additional context and observations*

## Reproduce
<!-- beads-phase-id: homelab-apps-12.1 -->
### Tasks

*Tasks managed via `bd` CLI*

## Analyze
<!-- beads-phase-id: homelab-apps-12.2 -->
### Tasks

*Tasks managed via `bd` CLI*

## Fix
<!-- beads-phase-id: homelab-apps-12.3 -->
### Tasks

*Tasks managed via `bd` CLI*

## Verify
<!-- beads-phase-id: homelab-apps-12.4 -->
### Tasks

*Tasks managed via `bd` CLI*

## Finalize
<!-- beads-phase-id: homelab-apps-12.5 -->
### Tasks

*Tasks managed via `bd` CLI*



---
*This plan is maintained by the LLM and uses beads CLI for task management. Tool responses provide guidance on which bd commands to use for task management.*
