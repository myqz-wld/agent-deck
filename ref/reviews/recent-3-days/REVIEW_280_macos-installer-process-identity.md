---
review_id: 280
reviewed_at: 2026-09-28
baseline_commit: 108d188447ce32b042885427da55db4c7d353979
expired: false
---

# Bound local installation shutdown to verified app processes

## Scope and method

Targeted repair requested while preparing an authorized local app replacement. Source inspection,
injected process-table regression tests, and read-only macOS process inspection were used. No
independent paired review was requested.

```review-scope
scripts/install-local-macos.mjs
scripts/install-local-macos.test.mjs
scripts/local-macos-processes.mjs
scripts/local-macos-processes.test.mjs
```

## Finding and fixes landed

| Severity | Finding | Resolution |
| --- | --- | --- |
| HIGH | The installer called `pkill -f` with broad application/helper names, allowing it to stop other app copies or similarly named processes and replace a bundle before exit completed. | Default to requiring an exited app. Explicit `--stop-running` uses the exact installed bundle path, PID, and start time; request graceful exit, revalidate before each SIGTERM, and require observed exit before replacement. |

## Validation and evidence

- Seventeen installer tests cover argument authorization, complete path parsing, unrelated app
  copies and helpers, orphaned bundle processes, graceful shutdown, SIGTERM fallback, ambiguous
  main processes, reused PIDs, newly spawned helpers, bounded failure, and an exit racing a signal.
- A read-only live process-table check found the installed main process without signaling it.
- Architecture checks and both TypeScript projects passed. CLI help and `git diff --check` passed.
- Full Electron test suite: 1,037 files and 6,442 tests passed; 2 files and 3 opt-in tests skipped.
  The SQLite binding hash remained unchanged.
- The review-expiry inventory was run without treating prior coverage as an exemption.

## Residual risk and follow-up

- macOS process inspection and signal delivery are separate operations. Rechecking PID, executable
  path, and second-resolution start time immediately before signaling narrows but cannot eliminate
  the final inspection-to-signal race. The default path sends no signals.
- A process created or restarted during shutdown causes installation to abort. The operator must
  inspect and retry; the installer does not silently adopt new identities.
- The stop option can terminate the invoking session when used inside Agent Deck. Use an external
  terminal or an explicitly authorized, independently supervised one-shot installer for that case.
- All changed source/test files remain below 500 lines.
