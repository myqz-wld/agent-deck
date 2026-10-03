---
review_id: 278
reviewed_at: 2026-09-28
baseline_commit: e6641148cf15448716c9065968834237d246ef09
expired: false
---

# Activate SVG Browser snapshot refs

## Scope and method

Targeted debugging of the session-private Browser CLI reporting an interactive SVG ref that
failed when clicked. Source inspection, failing regressions, and the session-scoped
`agent-deck-browser` CLI provided the evidence. No independent paired review was requested.

```review-scope
src/main/browser-use/engine/scripts.ts
src/main/browser-use/engine/__tests__/scripts-click.test.ts
```

## Finding and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Snapshot includes visible SVG elements with interactive roles, but click unconditionally invokes `el.click()`. SVG groups have no such method, causing `page_operation_failed` and `TypeError: el.click is not a function`. | Keep callable native click methods and dispatch a synthetic mouse click for elements without one, using the target document's event constructor and window. |

The fallback bubbles, is cancelable, and crosses open shadow boundaries so direct and delegated
listeners can receive it. HTML checkbox activation and disabled-button semantics continue to use
the native method. Snapshot generation, frame ownership, stale/detached ref checks, scrolling,
focus, and the action result shape are unchanged.

## Validation and evidence

- Reproduced the original failure in a background `about:blank` fixture through the private CLI:
  snapshot returned an SVG group ref, click failed with the reported error, and an HTML button
  succeeded. The fixture included SVG pointer, click, and keyboard listeners.
- Three new SVG regressions failed against the original implementation with
  `el.click is not a function`: top document, open shadow root, and same-origin iframe.
- All five new regressions pass after the fix. They also cover click cancellation, delegated
  listeners, the iframe event realm, HTML checkbox/disabled behavior, and stale/detached refs.
  Together with the existing script tests, the focused suite passed 15 tests across two files.
- `pnpm typecheck` passed architecture checks and both TypeScript configurations.
- Full `pnpm test`: 1,035 files and 6,419 tests passed; two files and three tests skipped.
  Tests used the existing Electron runner. The protected SQLite binding hash was unchanged.
- Evaluated the exact generated `clickScript` from the updated source using private CLI
  `evaluate --expression-file` and fresh snapshot refs in a background Browser fixture. Top SVG,
  shadow SVG, and iframe SVG listeners each ran once; delegation, cancellation, and iframe
  event realm checks succeeded. The HTML checkbox toggled once and the disabled button did not
  fire. Console capture, armed before execution, remained empty. The test tab was closed and
  temporary generated scripts were removed.
- Ran the review-expiry script and inspected the changed code without relying on old coverage.
  Rebucketed review records and linked plans/changelogs under the repository's date policy,
  preserving legacy index rows and updating references.
- `git diff --check` passed. Both changed source/test files remain below 500 lines.

## Residual risk

- Browser validation exercised the updated page script through the allowed CLI evaluate surface.
  It is not acceptance of the installed CLI click command after a rebuilt application update.
  The running installed application still contains the old implementation.
- This preserves semantic click behavior. It does not synthesize a complete pointer gesture or
  produce trusted physical input events; pointer-only interactions are outside this repair.

## Follow-ups

Apply the source fix through the normal application build/update workflow. The main runtime must
load the updated bundle for CLI click calls to use it. No live Agent Deck process or installed
bundle was stopped, restarted, or replaced; any such action requires explicit target approval.
