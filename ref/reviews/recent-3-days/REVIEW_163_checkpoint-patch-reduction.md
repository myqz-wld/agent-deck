---
review_id: 163
reviewed_at: 2026-07-15
baseline_commit: 4b58d6782ba11787b05e3423d545bc38b7955b6f
expired: false
skipped_expired: []
---

# REVIEW_163_checkpoint-patch-reduction: Deterministic checkpoint patch reduction

## Scope and method

This review traced the repeated checkpoint warnings and timeouts from application logs through the
persisted checkpoint/database state and isolated Codex generation diagnostics, reconstructed one
complete fold-plus-repair attempt, and reviewed the generator, prompt, validation, projection,
canonical-fit, commit, and retry paths. It then validated the patch-based replacement against the
full Electron-ABI suite and production build.

```review-scope
src/main/session/continuation-context/__tests__/checkpoint-background-refresh.test.ts
src/main/session/continuation-context/__tests__/checkpoint-fold-failure.test.ts
src/main/session/continuation-context/__tests__/checkpoint-fold-overflow.test.ts
src/main/session/continuation-context/__tests__/checkpoint-fold.test.ts
src/main/session/continuation-context/__tests__/checkpoint-generator.test.ts
src/main/session/continuation-context/__tests__/checkpoint-overflow-fixtures.ts
src/main/session/continuation-context/__tests__/checkpoint-patch-reducer.test.ts
src/main/session/continuation-context/__tests__/checkpoint-patch-schema.test.ts
src/main/session/continuation-context/__tests__/checkpoint-prompts.test.ts
src/main/session/continuation-context/__tests__/codex-isolation.test.ts
src/main/session/continuation-context/__tests__/codex-live-smoke.test.ts
src/main/session/continuation-context/__tests__/runtime.test.ts
src/main/session/continuation-context/__tests__/service.test.ts
src/main/session/continuation-context/checkpoint-fold-chunk.ts
src/main/session/continuation-context/checkpoint-fold-failure.ts
src/main/session/continuation-context/checkpoint-fold.ts
src/main/session/continuation-context/checkpoint-generator.ts
src/main/session/continuation-context/checkpoint-patch-reducer.ts
src/main/session/continuation-context/checkpoint-patch-schema.ts
src/main/session/continuation-context/checkpoint-patch-validation.ts
src/main/session/continuation-context/checkpoint-prompts.ts
src/main/session/continuation-context/runtime.ts
```

## Runtime evidence

- The sampled unrotated application log contained 44 checkpoint failures: 41 validation failures,
  one fold-generation timeout, and two repair timeouts. The dominant session remained at checkpoint
  revision 2,490 while its source revision grew past 63,000.
- A representative initial request was 332,577 bytes (about 95,616 estimated tokens), produced a
  23,214-byte full checkpoint, and took 121 seconds. Its repair request grew to 357,625 bytes (about
  102,818 estimated tokens), produced another full checkpoint, and took another 121 seconds.
- The first candidate changed or removed 15 active/blocked facts without current-delta evidence.
  Fail-fast validation reported one fact, so the single repair fixed only that first violation and
  left the remaining violations for a call budget that no longer existed.

## Confirmed findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The model regenerated the complete checkpoint even though its useful job was only to infer state changes. Normal wording drift became a carry-forward failure, and unchanged facts could be lost or rewritten. | Replace full-state output with a transient patch. A deterministic reducer starts from the full persisted checkpoint, applies only named additions/field changes, merges evidence, and leaves every omitted fact exact. |
| MEDIUM | Semantic validation rules were partly hidden in code and validation stopped at the first failure, forcing the model to repair by trial and error. | Keep one shared actionable rule list in the first-attempt system prompt. Schema and semantic validation aggregate all detected issues, and repair receives each issue's code, JSON path, message, and required action. |
| MEDIUM | Repair replayed the full prior checkpoint, normalized delta, allowlist, and invalid full output, making the second call larger than the first and consuming almost the entire 300-second deadline. | Repair now receives a bounded invalid patch, compact prior-fact index, exact current evidence, and structured issues. A regression proves repair stays more than 10x smaller than a representative 300KB fold delta. |
| LOW | New patch failures would otherwise collapse into the safe but unhelpful `unclassified` diagnostic reason. | Map patch schema, evidence, target, no-op, capacity, and reserved-id failures to stable redacted diagnostic categories while keeping detailed fact-level issues only inside isolated repair input. |

## Validation

- `pnpm typecheck` passed.
- `pnpm test` passed 318 files and 2,886 tests; the opt-in Codex live smoke was skipped in that
  default suite and then run explicitly against a real Codex app-server provider. It passed in
  15.9 seconds with one provider call, zero repairs, at least one patch operation, exact preservation
  of an omitted prior goal, and successful revision-1-to-2 CAS persistence in isolated SQLite.
- `pnpm build`, `pnpm logger:check`, `bash scripts/file-level-review-expiry.sh`, and
  `git diff --check` passed.
- Focused tests cover empty-patch revision progress, byte-stable omitted facts, field-level updates,
  evidence merging, multiple simultaneous semantic issues, schema paths/actions, bounded repair,
  overflow fitting, CAS conflicts, and Claude/Codex structured-output schema passthrough.
- All changed production TypeScript files remain below 500 lines; `checkpoint-fold.ts` is the
  largest at 467 lines.

## Residual risk and deployment note

- The initial fold still contains the normalized source delta, so a single very large first call can
  remain slow. This fix removes the second full-delta replay and large full-checkpoint output; it
  does not change the 300-second deadline, chunk budget, call count, or backoff policy.
- The real Codex structured-output path passed. Claude and Deepseek were not called live; their
  nullable field-level schema and Deepseek JSON-only fallback remain covered by adapter tests.
- Repair intentionally removes an operation it cannot ground from the candidate, fact index, and
  exact evidence list rather than inventing a mutation. A pathological invalid candidate can
  therefore reduce to an empty patch; the initial prompt and deterministic evidence rules are the
  primary semantic defense.
- This changes Electron main-process behavior. The production fold/generator/persistence path was
  exercised directly, but the active Agent Deck instance owns this SDK session and was not
  restarted; a normal application restart is still required to exercise the updated scheduler in
  the installed host.
