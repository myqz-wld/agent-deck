---
changelog_id: 401
changed_at: 2026-07-27
---

# CHANGELOG_401_concurrent-batch-review: Preserve adversarial review across concurrent batches

## Summary

`simple-review` and `deep-review` can now partition a broad change by subsystem or decision
boundary and run the resulting batches concurrently within Agent Deck's spawn limits. Concurrency
does not weaken the adversarial contract: every batch receives one complete worker from each of the
two user-selected heterogeneous reviewer types, and neither worker may review only half a batch.

The protocol is aligned across Claude Code, Codex CLI, and Grok Build.

## Changes

### Review batch planning

- Add an invocation-level batch manifest with stable batch ids, primary/integration kinds, absolute
  scopes, dependency boundaries, baselines, focuses, and lifecycle state.
- Keep strongly coupled files and producer-consumer contracts together instead of splitting by an
  arbitrary file count.
- Add an integration batch whenever two or more primary batches exist, so shared invariants and
  cross-subsystem state flows still receive explicit adversarial coverage.
- Dispatch only complete two-worker pairs. Use returned `spawnLimits` to bound concurrent waves and
  queue remaining pairs instead of creating intentional single-reviewer batches.

### Adversarial evidence and convergence

- Qualify findings by batch and preserve their ids through rebuttal, aggregation, fixes, and later
  deep-review rounds.
- Track coverage per reviewer, batch, and round. One surviving worker never counts as complete
  coverage when its heterogeneous counterpart fails.
- Keep simple review to one independent review round plus one rebuttal round across all batches.
- Let deep review advance independent batches concurrently, re-review affected dependencies after
  fixes, and require a final integration pass after the last boundary-affecting change.

### Three-adapter runtime alignment

- Align Claude, Codex, and Grok review skills on the same batching behavior.
- Reframe the selected pair as exactly two reviewer types, allowing one batch-specific worker
  session of each type for every concurrent batch.
- Require `batch_id`, `batch_kind`, and `batch_scope` in all three reviewer agents.
- Isolate temporary reviewer files under
  `/tmp/agent-deck-review/<invocation_id>/<batch_id>/<reviewer>/`.
- Extend bundled-resource tests to cover all three runtime baselines, all three skill copies, and
  all three reviewer input contracts.

## Validation

- `pnpm vitest run src/main/codex-config/__tests__/bundled-reviewer-runtime.test.ts` passed 10 tests.
- `pnpm typecheck` passed.
- `pnpm test` passed 377 files and 3,166 tests, with one file and one test skipped.
- `pnpm build` passed.
- Claude, Codex, and Grok copies of each review skill are byte-identical.
- `git diff --check` passed.
- No dedicated standalone skill validator exists in this repository; frontmatter, resource
  alignment, runtime parsing, and batch-contract validation are covered by the bundled reviewer
  runtime test.

## Do Not Split Protection

No changed source or prompt asset exceeds 500 lines.

## Notes

The root README and `resources/README.md` already name all three adapters and require their
same-name skills and reviewer bodies to stay behaviorally aligned, so no README change was needed.
Prompt-asset backups and their original hashes are stored under the ignored local
`.prompt-asset-improver` workspace.
