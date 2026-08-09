---
changelog_id: 549
changed_at: 2026-08-05
---

# CHANGELOG_549_safe-diagnostic-text-core-boundary: Publish safe diagnostic text Core

## Summary

Claude create-session startup failure rendering no longer reaches through the desktop diagnostic
facade. Inline-secret, local-path, and bounded display-text policy now lives in a provider-neutral
Node Core shared by the existing desktop diagnostic serializer.

## Diagnostic text Core

- Extracted inline credential redaction, local home/temp/workspace path redaction, deterministic
  truncation, and the 3,072-character display ceiling into `src/core/safe-diagnostic-text.ts`.
- Kept `safe-diagnostic.ts` as the compatibility facade for desktop log serialization while
  importing and re-exporting the exact Core primitives, preventing policy drift.
- Pointed the Claude create-session orchestrator directly at the Node Core.
- Expanded its architecture rule to reject the old desktop diagnostic facade.
- Added Node 22 bundle candidates for both the diagnostic Core and the complete Claude
  create-session orchestrator, bringing the executable boundary gate to 90 candidates.

## Preserved startup behavior

- Fast-return startup failures still emit one visible error and one failed terminal event.
- Sensitive inline authorization values, API keys, and local filesystem paths stay redacted before
  renderer publication.
- Error classification, exact Chinese prefix, background startup scheduling, pending-cwd release,
  SDK claim rollback, transient-row cleanup, and original exception authority are unchanged.
- The broader persisted/console diagnostic serializer retains its prior limits, hostile-accessor
  handling, and log-hook behavior through the same extracted string policy.

## Direct evidence

- New Core tests cover inline credentials, home/temp/workspace paths, caller-owned ceilings, and the
  fixed display ceiling without loading desktop modules.
- Existing safe-diagnostic tests prove serializer behavior did not drift after extraction.
- Existing create-session fail-fast and cleanup suites retain background visible-failure,
  canonical-id, rollback, interrupt, and orphan-cleanup coverage.
- The complete create-session orchestrator bundles for Node 22 with no Electron or electron-log
  dependency.

## Validation

- Focused Core/diagnostic/create-session coverage: passed, 4 files / 30 tests.
- Claude plus diagnostic Core coverage: passed, 128 files / 506 tests.
- Node and web TypeScript plus architecture gates passed with 90 Node candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 740 files / 5,038 tests plus 1 skipped.
- `create-session-impl.ts` is 410 lines; the new Core is 55 lines.
- The cached Git index remains empty; no shared development or Electron process was touched.

## Do Not Split Protection

Keep the Core extraction, desktop-facade reuse, direct create-session import, architecture rule,
both Node candidates, and redaction regressions together. Duplicating the regex policy or retaining
the desktop facade in the orchestrator would reintroduce policy drift or hidden composition.

## Remaining boundary

The complete disconnect-recovery and JSONL fallback orchestrators now have injected ownership but
are not yet executable Node candidates. The next bounded slice should add those transitive bundle
gates and repair only concrete dependency leaks they reveal, without changing recovery semantics.
