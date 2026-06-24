# REVIEW_140

## Trigger Context

The user requested one approved round of large-file splitting followed by a deep review of the resulting changes.

This review covers the behavior-preserving split of:

- `src/main/agent-deck-mcp/tools/schemas.ts`
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts`
- `src/renderer/stores/session-store.ts`
- `src/main/adapters/codex-cli/app-server/client.ts`
- `src/main/session/manager.ts`

`src/main/agent-deck-mcp/__tests__/tools.test.ts` was explicitly deferred for a separate future session and was not changed.

## Method

Deep review used the required heterogeneous reviewer pair:

- `reviewer-codex`: session `019ef7ce-0c80-7d13-8c96-b29658af74ca`, reply `c7f0723d-5cda-4d7b-9193-3ea558c9b186`.
- `reviewer-claude`: session `bb38b1d6-435d-43e7-8ef7-d386a978d145`, reply `a4d9320c-7502-4416-9356-8446d0146846`.

Review scope:

- Current working tree tracked diff for the five split areas.
- Untracked helper/schema modules added under the same scope.
- Public facade preservation, lifecycle-sensitive helper moves, streaming/abort helpers, Zustand event dedupe, and session manager singleton state.

## Gate Result

PASS.

Severity distribution:

- CRITICAL: 0
- HIGH: 0
- MEDIUM: 0
- LOW: 0
- INFO: 3 accepted as non-blocking maintenance notes

Both reviewers independently reported no material correctness, lifecycle, security, or performance regression from this behavior-preserving split.

## Decision List

### PASS: schema facade split preserved exported schema surface

Decision: accepted as clean.

Evidence:

```ts
export * from './schemas/shared';
export * from './schemas/spawn';
export * from './schemas/session';
export * from './schemas/retired';
export * from './schemas/tasks';
export * from './schemas/issues';
```

Reviewer coverage confirmed the domain schema modules do not import back through the facade, and schema constraints such as descriptions, refinements, min/max limits, regexes, and enum shapes were preserved.

### PASS: spawn handler helper extraction preserved lifecycle behavior

Decision: accepted as clean.

Evidence:

```ts
await recordPermissionMode(args, session.sessionId);
setSessionTitle(session.sessionId, title);

const membership = await completeSpawnTeamMembership({
```

Reviewers checked the critical ordering around permission-mode persistence, title update, team membership, placeholder creation, orphan cleanup, and spawn-limit release behavior.

### PASS: Codex app-server client extraction preserved public test and protocol surface

Decision: accepted as clean.

Evidence:

```ts
export type {
  AppServerEvent,
  CodexThreadConfig,
  CodexThreadOptions,
  TurnResponse,
} from './protocol';
```

Reviewers confirmed `client.ts` still exposes the client classes and `__testables` expected by existing tests while moving thread parameter and notification helpers into sibling modules.

### PASS: session manager extraction preserved singleton state sharing

Decision: accepted as clean.

Evidence:

```ts
export {
  getSessionCloseFn,
  getSessionRenameHookFn,
  setSessionCloseFn,
  setSessionRenameHookFn,
} from './manager/hooks';
```

Reviewers confirmed bootstrap hook injection and manager close/rename reads share the same module-level state after extraction, and SDK pending-claim TTL behavior was preserved.

### PASS: renderer session store helper extraction preserved dedupe semantics

Decision: accepted as clean.

Evidence:

```ts
const merged = [...existing, ...incoming].sort((a, b) => b.ts - a.ts);
return dedupeRecentEvents(merged).slice(0, limit);
```

Reviewers checked the sort, dedupe, duplicate tool-event merge, limit slicing, pending request bucket movement, and map pruning behavior against the original inline implementation.

## INFO Findings

### INFO accepted: duplicate `__testables` export in `thread-params.ts`

Decision: accepted as non-blocking. The public test entry remains `client.ts`; the extra helper-level export has no runtime impact and can be removed in a future cleanup.

### INFO accepted: unused `args` field in `BuildSpawnPromptContextInput`

Decision: accepted as non-blocking. The field is unnecessary coupling created by the mechanical extraction and can be removed in a future cleanup.

### INFO accepted: shared schema description constants became exported through the facade

Decision: accepted as non-blocking. The widened public surface is a side effect of sharing schema constants across split modules. It does not change runtime behavior; a future named facade export can hide them if the project wants a narrower export surface.

## Validation

- `pnpm typecheck` passed.
- `pnpm test:node -- src/main/agent-deck-mcp/__tests__/tools.test.ts src/renderer/stores/__tests__/session-store.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/codex-cli/app-server/translate.test.ts src/main/session/__tests__/manager-ingest.test.ts src/main/session/__tests__/manager-public-api.test.ts` passed.
- The focused command collected the broader suite and reported `159 passed | 19 skipped` test files and `1723 passed | 293 skipped` tests. The skipped cases are the existing better-sqlite3 ABI guard under the system Node runtime.
- Reviewer-side focused validation also passed for the scoped test files. One reviewer observed unrelated local sandbox `listen 127.0.0.1` failures in a full suite attempt; those were outside the split scope and not reproduced in the lead validation.

## Related Changelog

[CHANGELOG_326](../changelogs/CHANGELOG_326.md).
