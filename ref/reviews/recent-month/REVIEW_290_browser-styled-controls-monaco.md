---
review_id: 290
reviewed_at: 2026-09-29
baseline_commit: ad6ece107dc229865d8a55b4752866bb4d1d9249
expired: false
---

# Styled controls and Monaco input

## Scope and method

Targeted debugging during Feishu application setup. Live Browser snapshots and DOM inspection
identified the failures; source inspection, DOM regressions and an isolated real-Electron fixture
validated the repair. No independent paired review was requested.

```review-scope
src/main/browser-use/engine/actions.ts
src/main/browser-use/engine/scripts.ts
src/main/browser-use/engine/visibility-script.ts
src/main/browser-use/engine/editor-input.ts
src/main/browser-use/engine/__tests__/styled-controls.test.ts
src/main/browser-use/engine/__tests__/editor-input.test.ts
scripts/fixtures/browser-editor-electron.ts
scripts/fixtures/browser-engine-electron.ts
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Transparent native checkboxes with visible labels were omitted, making permission selection unavailable through refs. | Recognize labeled, positive-size checkbox/radio controls while retaining hidden ancestor, frame, disabled and ref-generation boundaries. Empty labels can use bounded permission-row text. |
| MEDIUM | Typing changed Monaco's textarea projection without updating its document model. | Route selection and paste through the editor's target-document handlers. Preserve asynchronous paste settlement, replacement, append, clear and Enter behavior. |

Renderer focus emulation is restored in `finally`; the host window is never raised. Concurrent
typing on one tab is rejected before it can move focus. Ref, document, focus and read-only checks
fence editor operations. The action result omits the textarea projection's misleading value.
Plain fields keep their existing value-setter path. Public CLI arguments and session ownership
remain unchanged.

## Validation and evidence

- DOM regressions cover styled checkbox/radio activation, hidden/unlabeled/zero-size exclusions,
  disabled state, bounded row descriptions, shadow hosts, stale refs and detached elements.
- Editor regressions cover read-only textareas, stale references, focus movement and overlapping
  typing. The preparatory script leaves the original textarea value untouched.
- `pnpm test:browser-electron` passed with locally served Monaco 0.55.1 using its textarea input
  path, both at top level and inside a same-origin iframe. Assertions read the actual editor
  model after JSON replacement, Unicode/multiline append, empty replacement and Enter. The host
  window focus counter stayed zero; existing Browser boundary and persisted-login checks passed.
- Final combined `pnpm test`: 1,072 files and 6,613 tests passed; two files and three tests skipped.
  `pnpm typecheck` passed. Tests used the normal Electron-as-Node runner without replacing SQLite.
- Review-expiry helper was attempted and exited 1. The complete changed-file scope above was
  inspected without relying on historical review exemptions.
- All changed source modules remain below 500 lines. Staged-content privacy and whitespace checks
  passed; no credentials, account identifiers or personal machine paths were committed.

## Residual risk and follow-ups

The user subsequently authorized Desktop replacement, completed with clean `6d4d44ad` on
2026-09-29. Installed archive identity and signature passed. Through the installed session-scoped
Browser CLI, the local fixture exposed and toggled its transparent labeled checkbox and accepted
Unicode JSON into the actual Monaco model. The fixture tab and server were removed afterward.
The Browser issue remains resolved, now with installed activation evidence.

The fixture covers Monaco's textarea path, not every rich-editor implementation or custom paste
plugin. The Feishu console's plain callback-tab div has no supported interaction marker and still
needs a bounded manual navigation step. This does not broaden the repaired control-recognition
contract. See [installed acceptance](../../plans/recent-month/PLAN_64_feishu-desktop-activation.md).
