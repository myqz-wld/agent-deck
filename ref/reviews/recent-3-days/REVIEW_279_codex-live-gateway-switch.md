---
review_id: 279
reviewed_at: 2026-09-28
baseline_commit: 4a9f688effaf723790cd5672c6d30b6344737bac
expired: false
---

# Apply Gateway changes to loaded Codex sessions

## Scope and method

Targeted debugging of an existing Codex session continuing to use its previous Gateway after
the user changes the selection. Source tracing, regression tests, and isolated native Codex
0.156.0 probes provided the evidence. No independent paired review was requested.

```review-scope
src/main/adapters/codex-cli/app-server/thread-readiness.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/app-server/thread-gateway-refresh.test.ts
src/main/adapters/codex-cli/app-server/client.test.ts
```

## Finding and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Gateway persistence updates the selected profile, but `thread/resume` rejoins an already loaded native thread without applying its configuration overrides. Subsequent messages still use the old endpoint. The previous mock accepted overrides unconditionally and hid this behavior. | At the next readiness boundary, unsubscribe the loaded thread before resuming the same id with the new configuration. Accept only native `unsubscribed` or `notLoaded` results; an unsuccessful refresh blocks the message and remains retryable. |

Steering an active turn uses its existing readiness without consuming the pending Gateway
selection. The next turn performs the refresh after the current turn completes. Concurrent
readiness callers share the operation, and a newer selection arriving during resume triggers
another refresh before a message can start. Model, thinking, approval, sandbox, and conversation
identity remain governed by their existing selections.

The old permissive Gateway test moved into a dedicated regression suite that models native
loaded-thread behavior. The existing client test file is now below the 500-line guardrail.

## Validation and evidence

- Native protocol reproduction: start with a synthetic provider, persist a synthetic history
  item, and resume with another provider. The loaded thread reports the original provider.
  Unsubscribe followed by resume reports the newly selected provider.
- The bundled runtime's generated protocol types identify `thread/unsubscribe` and its three
  statuses: `unsubscribed`, `notLoaded`, and `notSubscribed`.
- Ten of eleven new regressions failed against the original implementation. All eleven pass
  after the repair, covering default restoration, profiles sharing a provider id, active-turn
  steering, concurrent readiness, newer selections, unload failures, and resume retries.
- Focused renderer, bridge, thread-parameter, lifecycle, and Gateway suite: 6 files, 58 tests passed.
- Bundled the updated production client/thread code into a disposable native probe. Four actual
  Codex turns sent Responses requests to a local fixture in this order: old Gateway, new Gateway,
  another endpoint with the same native provider id, then native default configuration. Each
  response matched the destination; all four requests retained the same thread id and preceding
  conversation content. No real credentials, remote model endpoints, or user sessions were used.
- `pnpm typecheck` passed architecture checks and both TypeScript projects.
- Full `pnpm test`: 1,036 files and 6,429 tests passed; two files and three tests retained their
  existing skips. The Electron runner left the SQLite binding hash unchanged.
- Ran the file-level review-expiry inventory and inspected the changed paths without treating
  prior records as exemptions. All changed source/test files are below 500 lines.
- Temporary native schema/probe files were removed after validation. `git diff --check` passed.

## Residual risk and follow-up

The native acceptance probe exercised the updated source with loopback fixtures. The installed
application still contains its previous bundle. Loading this repair requires the normal build,
installation, and application restart workflow; no running Agent Deck process or installed bundle
was stopped, restarted, or replaced in this task.

Related plan: [Codex live Gateway switching](../../plans/recent-3-days/PLAN_57_codex-live-gateway-switch.md).
