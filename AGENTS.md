# AGENTS.md

> Codex project entry point. Shared repository workflow lives in [`CLAUDE.md`](CLAUDE.md). This file records only Codex entry-point or tool differences.

## Required Reading

Read [`CLAUDE.md`](CLAUDE.md) before task work and follow its shared repository workflow.

## Host Runtime Safety

Treat running Agent Deck applications, Electron or development processes, listeners, and installed
bundles as live user-owned state because the current Codex session may be hosted by that runtime.
Never stop, kill, restart, relaunch, replace, or install over them unless the user explicitly
approves the exact target and action in the current conversation. When a restart is needed, report
it and ask; a repository validation or restart instruction is not authorization. Follow the
detailed `Host Runtime Safety` section in [`CLAUDE.md`](CLAUDE.md).

## Codex-Specific Differences

- When work involves in-app Codex SDK sessions, MCP, skills, or packaged prompt assets, also read [`resources/codex-config/CODEX_AGENTS.md`](resources/codex-config/CODEX_AGENTS.md).
- When work involves Claude counterpart assets, compare against [`resources/claude-config/CLAUDE.md`](resources/claude-config/CLAUDE.md). Adapter wording may differ, but protocol semantics must stay aligned.
