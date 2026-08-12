---
review_id: 156
reviewed_at: 2026-07-12
baseline_commit: 1eddae7ccce3260083c1df6e67c7222728dc64ae
expired: false
skipped_expired:
  - file: "*"
    reason: "This focused cross-repository regression review covers only the machine-readable scope below."
---

# REVIEW_156_codex-mcp-synchronized-readiness: Synchronized Codex MCP readiness isolation

## Scope and method

This was the Agent Deck half of the cross-repository Codex MCP concurrency
repair. Its production app-server lifecycle was audited against the AI Review
Assistant incident and exercised with three synchronized clients. The user
explicitly waived reviewer agents, so the lead used direct code inspection,
deterministic reproduction, and repository validation.

```review-scope
ref/reviews/recent-week/INDEX.md
src/main/adapters/codex-cli/app-server/client.test.ts
```

## Verdict

**PASS with regression hardening only.** Agent Deck's existing production
behavior already preserves required MCP configuration, isolates readiness state
per client, resets a rejected readiness promise, and retries only that client.
The synchronized repository-local reproduction did not expose a production
defect, so no production code changed under the approved evidence gate.

## Findings

### LOW-1 fixed — synchronized multi-client ownership lacked a direct regression

The suite independently covered required MCP configuration, rejected readiness
reset, stale child exit, and fresh per-request HTTP transport, but did not put
three clients through the same first readiness boundary. A future shared-promise
or retry-state regression could therefore affect successful siblings without a
single focused failure.

The new test synchronizes three first `thread/start` attempts, rejects only the
second required-MCP boundary, and proves exact attempt counts `[1, 2, 1]`. The
two successful clients retain their original thread ids, only the failed client
gets a fresh readiness attempt, and every boundary keeps `required: true`.

## Validation evidence

- `bash scripts/file-level-review-expiry.sh` completed before review; the exact
  reviewed files are listed above.
- The final focused app-server client suite passed 13/13 tests.
- The six-file app-server/observer/HTTP transport matrix passed 59/59 tests.
- `pnpm typecheck` passed.
- After rebasing onto the latest `origin/main`, the full test suite passed 282
  files and 2,654 tests with one explicit live smoke skip. Two unrelated tests
  that timed out only while typecheck ran concurrently passed 113/113 in an
  isolated rerun and passed again in the final standalone full suite.
- `git diff --check` passed, and the changed test file remains at 421 lines.

## Fixes landed

- Added one deterministic synchronized-three regression to
  `client.test.ts`; production adapter, transport, configuration, and session
  lifecycle files remain byte-for-byte unchanged from the branch baseline.
- No README or changelog was added because runtime and user-visible behavior did
  not change.

## Residual risk

- This test models the app-server boundary deterministically rather than
  launching three credentialed Codex children. AI Review Assistant's separate
  preflight harness supplies the real shared-home cold-start evidence for the
  cross-repository invariant.
- A future Codex protocol change can alter upstream readiness diagnostics. The
  required configuration and per-client state assertions should remain exact.

## Follow-ups

No required Agent Deck production follow-up remains. If a future synchronized
reproduction fails, preserve the `[1, 2, 1]` ownership contract before changing
the adapter lifecycle.
