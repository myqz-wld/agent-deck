---
changelog_id: 427
changed_at: 2026-07-31
---

# CHANGELOG_427_compatibility-and-defect-remediation: Clean compatibility seams and close REVIEW_208 defects

## Summary

Agent Deck now carries a smaller current-only internal surface and closes all fifteen functional
defects confirmed by `REVIEW_208`. The repair hardens handoff authority and transactions, provider
process cancellation and executable materialization, Browser/CDP lifetime, mirror publication,
cross-platform image loading, and renderer recovery without reviving retired compatibility paths.

## Compatibility cleanup

- Removed zero-caller session, repository, continuation-spool, adapter, Browser, renderer, and
  shared-type facades while retaining live concurrency, security, recovery, and provider-variance
  safeguards.
- Removed the retired Codex `profile` rejection surface from CLI/MCP/runtime prompt contracts,
  canonicalized persisted Codex `changeKind` reads to the current string format, and deleted the
  unused packaged-Codex PATH wrapper.
- Retained the old screenshot-name reaper, Grok notification alias, valid-v61 row normalization,
  and resources-placeholder boundary because they still protect live external or persisted state.

## Defect remediation

- Enforce durable lifecycle authorization for in-process MCP callers, cancel handoff endpoint rows
  that would collapse to self-messages, move teammate membership atomically, and record shutdown
  reasons in structured operator logs.
- Materialize bundled Grok only in a user-owned validated cache; interrupt accepted Codex turns
  exactly once across abort/output/detach races; release closed Browser targets immediately; make
  console-domain enable retryable; atomically publish validated Codex skill mirrors; and bound
  node_repl child shutdown with repeated signal forwarding plus SIGKILL fallback.
- Make issue-resolution creation rollback-safe and retry-fenced, await transferred diff-review
  delivery, accept native Windows absolute paths without weakening canonical containment, fence
  stale permission refreshes, and surface caller-archive failures with bounded retry UI.

## Validation

- Full Electron-ABI suite: 446 files passed and 1 intentional live smoke skipped; 3,656 tests
  passed and 1 skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- Shell, CJS, and MJS syntax checks passed; bundled Grok 0.2.114 verification passed.
- Focused state/handoff, runtime, Browser, IPC/renderer, skills-mirror, and node_repl regressions all
  passed in both implementation sessions and lead integration.

## Notes

- Native Linux shared-host and Windows filesystem behavior is covered deterministically but was not
  executed on those operating systems; provider and Browser behavior was not live-smoked.
- Main/preload code cannot hot-reload into the active collaboration host. The changes take effect
  on the next normal Agent Deck launch; no restart was performed during this work.
- All changes remain unstaged and uncommitted.
