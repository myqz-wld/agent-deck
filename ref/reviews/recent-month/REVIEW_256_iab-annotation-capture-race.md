---
review_id: 256
reviewed_at: 2026-08-19
baseline_commit: 6f8a91fbdb904aaf1b593fbd26f8de80799b0a98
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final review records and bucket indexes are mechanical evidence added after the reviewed implementation commit."
---

# REVIEW_256_iab-annotation-capture-race: Stabilize IAB annotation capture

## Scope and method

This debug review reproduced the installed macOS IAB annotation failure from the application log,
where three consecutive `browser:annotation-capture` invocations rejected with `Browser page
changed during annotation capture; retry with a fresh view.` The page itself remained stable: its
console was empty, its reload returned HTTP 200, and no navigation occurred.

The review traced the failure to asynchronous renderer placement updates changing the Browser
viewport revision while `capturePage` was in flight. It inspected capture stability, presentation
lease freshness, renderer placement readiness, delayed projection delivery, Remote composer parity,
and the existing continuous-resize and navigation rejection boundaries. The repository expiry
report was run before the fix; unrelated expired and scope-unknown files were not claimed here.

```review-scope
src/main/browser-use/browser-presentation-controller.test.ts
src/main/browser-use/browser-presentation-controller.ts
src/renderer/components/SessionDetail/IabPanel.test.tsx
src/renderer/components/SessionDetail/IabPanel.tsx
src/renderer/components/SettingsDialog.remote.test.tsx
src/renderer/remote-host/SessionDetail.source-shell.test.tsx
```

## Findings

### MEDIUM — transient viewport placement made annotation repeatedly unavailable — fixed

The main process treated any viewport revision change during one screenshot attempt as a terminal
page-change error. The renderer also enabled annotation as soon as it had a presentation lease,
before the initial native view placement promise settled. After the first error, clearing the
layout-affecting status row on retry could produce another revision change and repeat the failure.

The capture response can also carry a projection newer than the renderer's event-delivered
snapshot. Comparing that response immediately against the older renderer snapshot incorrectly
cancelled an otherwise valid frozen annotation.

## Fixes landed

- Annotation capture now accepts only a frame whose URL, presentation bounds, viewport revision,
  CSS viewport, and scroll position remain stable before and after capture.
- Transient bounds, revision, or scroll changes receive at most three bounded capture attempts.
  Real navigation still fails immediately, and continuous viewport churn still fails without
  parking the live view or returning a mismatched PNG.
- The controller revalidates the presentation lease after every asynchronous page read and capture,
  preventing a stale lease from committing an annotation after ownership changes.
- The renderer keeps the annotation control disabled until the latest native placement request
  settles, invalidates superseded placement promises, and waits for an authoritative capture
  projection to catch up before applying navigation/viewport invalidation.
- Local and Remote annotation tests now wait for placement readiness. A stale Remote settings test
  assertion was narrowed so the intentional explanatory phrase `Remote Core` no longer looks like
  the removed legacy `Remote Core 配置` surface.

## Validation and evidence

- The four new regression cases failed before implementation and pass afterward: transient
  revision retry, persistent revision rejection, settled-scroll retry, and immediate navigation
  rejection.
- Focused controller and IAB panel validation passed 2 files / 16 tests.
- Remote IAB composer and Remote settings validation passed 2 files / 17 tests.
- `pnpm typecheck` passed architecture checks plus Node and renderer TypeScript checks.
- `pnpm test:browser-electron` passed the real-Electron presentation, focus, responsive viewport,
  physical-pixel capture, and annotation boundaries.
- The complete `pnpm test` suite passed 994 files / 6,235 tests. The existing opt-in live Colima,
  Codex live-smoke, and provider transport cases remained skipped (3 tests total).
- `pnpm build` passed for main, preload, and renderer, and `git diff --check` passed.

## Residual risk

- Continuous user resize, real navigation, or ongoing scripted scrolling during all three attempts
  intentionally remains a safe annotation rejection rather than returning a potentially
  misregistered image.
- Remote Core live IAB behavior still requires a configured external target and remains outside
  this Local installed-app fix.
- All changed production files remain below the 500-line guardrail.

## Follow-ups

- Keep the stable-frame attempt cap bounded if capture implementation or viewport revision
  semantics change.
- Treat an installed-app annotation gesture as final Local acceptance after packaging the clean
  review commit; do not infer Remote acceptance from that Local result.
