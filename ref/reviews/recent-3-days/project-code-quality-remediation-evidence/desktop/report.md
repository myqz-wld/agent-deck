# Desktop implementation evidence

Captured at worker handoff and accepted by the lead. Subsequent global validation and fixture-only corrections are recorded in REVIEW_269. The pending lead actions in the original handoff below are historical.

## Worker results

Status: **ready-for-review**. Desktop-02/03/04/05 are remediated, and the linked desktop-06 shared paging opportunity is implemented. Assignment and the parent plan are unchanged.

### Implementation decisions

- Local and Remote now use `useFileChangePages` and pure `file-change-pages` transitions. Activation and same-source revision refreshes revalidate the head. Identity/workspace changes reset caches and invalidate outstanding results; activation retains history selection. A separate contiguous window tracks which cached rows are safe overlap evidence. A refresh preserves an old cursor only when the new head joins that window before its frontier; otherwise the new cursor remains available to fill the gap. This preserves cached selections without skipping unseen burst records. Load-more cannot cancel an in-flight head refresh, and a newer head refresh supersedes an older page request.
- `selectProfile(profileId, { activate: true })` now queues profile selection and optional Remote activation as one complete intent. All header and profile-manager choices advance the same intent sequence. A later choice fences the earlier activation before the second persistence call, so snapshot revision filtering is no longer the only protection. Profile-manager choices without activation retain their existing mode behavior.
- Browser tabs carry their engine-owned owner/tab identity into show requests. Production bootstrap now supplies an actual show consumer. The controller verifies the surface against that owner and its Local projection before requesting a foreground window. It restores a minimized window, shows/focuses an existing hidden window, and uses the existing floating-window creation path when closed. These actions occur only for explicit show requests in the implemented runtime; none were exercised against the live host during this task.
- Browser show requests flow through the typed event bus and `safeSend`, synchronized shared channels and preload methods, and the renderer's Local source/session/IAB navigation. A pending-state invoke supports a renderer that starts after the push event. The IAB key stays mounted after successful completion; repeated explicit requests force a fresh placement even when metadata is unchanged.
- `open --show` awaits owner-qualified presentation completion, including the actual surface visibility/focus check, before reporting `visible: true`. Repeated pending requests for the same surface share a waiter. A newer surface supersedes the older request; teardown, invalid ownership, or the bounded five-second presentation deadline resolve as invisible. Default open remains in the background. Main never accepts a renderer-supplied window identity for the pending read or presentation lease.
- No new packaged prompts, tool descriptions, dependencies, native bindings, root configuration, or public Browser CLI fields were needed. The actual shared Browser contract is `src/shared/browser-view.ts`; the lead reconfirmed that path as authorized in the latest reply.

### Changed files

33 changed/new files, all in the authorized source/test scope:

```text
src/main/browser-use/__tests__/show-fakes.ts
src/main/browser-use/browser-presentation-controller.ts
src/main/browser-use/browser-presentation-runtime.ts
src/main/browser-use/browser-show-controller.test.ts
src/main/browser-use/browser-show-controller.ts
src/main/browser-use/browser-show-ipc.test.ts
src/main/browser-use/browser-show-runtime.ts
src/main/browser-use/engine/registry.ts
src/main/browser-use/engine/surface.ts
src/main/browser-use/engine/tab.ts
src/main/browser-use/operation-executor.ts
src/main/browser-use/view-host.ts
src/main/event-bus.ts
src/main/index/__tests__/bootstrap-wiring-observability.test.ts
src/main/index/__tests__/checkpoint-bootstrap-entry.test.ts
src/main/index/bootstrap-infra.ts
src/main/index/bootstrap-wiring.ts
src/main/ipc/browser.ts
src/preload/api/browser.ts
src/renderer/App.tsx
src/renderer/components/SessionDetail/RemoteDiffPanel.tsx
src/renderer/components/SessionDetail/__tests__/file-change-continuity.test.tsx
src/renderer/components/SessionDetail/file-change-pages.ts
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionDetail/remote-diff-continuity.test.tsx
src/renderer/components/SessionDetail/use-file-change-pages.ts
src/renderer/components/SessionDetail/use-file-changes.ts
src/renderer/hooks/use-browser-show.test.tsx
src/renderer/hooks/use-browser-show.ts
src/renderer/remote-host/source-selection-intents.test.tsx
src/renderer/remote-host/use-remote-host-snapshot.ts
src/shared/browser-view.ts
src/shared/ipc-channels.ts
```

### Permanent regression coverage

- Actual Local hook activation with manual history selection, a 51-change burst with exhausted and existing cursors, repeated head refresh before gap loading, session/worktree fences, Remote identity fences, disabled results, and head/load-more arbitration.
- Actual Remote Diff panel burst/load-more behavior for both exhausted and non-exhausted histories, selection preservation, and source-change reset. Existing same-identity revision refresh and stale-page tests remain passing.
- The regression extracts and executes the actual App JSX source-selection callback with the production snapshot hook and deferred persistence. It covers Remote → Local, Remote → Local → Remote, a newer profile-manager selection, and recovery after an older failure.
- Actual Browser executor + engine + view host + presentation controller with fake Electron surfaces/windows: background default, absent show consumer, actual placement completion, repeat/coalesced show, wrong renderer/source/tab, a different owner with the same tab id, supersession by a new tab, owner/window/renderer teardown, controller reset, a closed-window replacement, and hidden-window expiry.
- Production bootstrap callback installation and reset, event-bus/safeSend delivery, main IPC registration and sender identity, typed preload forwarding/unsubscribe, and the actual IAB renderer component. Renderer coverage includes delayed startup, positive Local authority, expired requests, stale initial reads, owner mismatch, and retaining the successful placement after completion.

### Validation and evidence

Final Electron-compatible focused run, one worker:

```sh
pnpm run test src/main/browser-use \
  src/renderer/components/SessionDetail/__tests__/use-file-changes.test.tsx \
  src/renderer/components/SessionDetail/__tests__/file-change-continuity.test.tsx \
  src/renderer/components/SessionDetail/RemoteDiffPanel.test.tsx \
  src/renderer/components/SessionDetail/remote-diff-continuity.test.tsx \
  src/renderer/components/SessionDetail/IabPanel.test.tsx \
  src/renderer/hooks/use-browser-show.test.tsx \
  src/renderer/remote-host/use-remote-host-snapshot.test.tsx \
  src/renderer/remote-host/source-selection-intents.test.tsx \
  src/renderer/components/RemoteHost/RemoteHostManagerDialog.test.tsx \
  src/main/ipc/__tests__/browser.test.ts \
  src/main/index/__tests__/checkpoint-bootstrap-entry.test.ts \
  src/main/index/__tests__/bootstrap-wiring-observability.test.ts \
  src/main/index/__tests__/bootstrap-wiring.test.ts \
  --maxWorkers=1 --minWorkers=1
```

Result: **34 files / 232 tests passed**, 13.85 seconds. Output: `ref/reviews/recent-3-days/project-code-quality-remediation-evidence/desktop/focused-tests.log`.

Additional worker checks:

- TypeScript API compilation using both existing project configurations, with diagnostics restricted to the desktop source/test write scope: `tsconfig.node.json` **0**, `tsconfig.web.json` **0**. Script/output: `ref/reviews/recent-3-days/project-code-quality-remediation-evidence/desktop/typecheck.cjs` and `typecheck.log`. This is a scoped diagnostic check; it does not replace the lead's integrated typecheck.
- `git diff --check`: passed.
- Owned-file inventory/size check: **33 files**, none over 500 lines. The largest is the existing bootstrap wiring test at exactly 500 lines; production `App.tsx` is 483 lines. Inventory: `ref/reviews/recent-3-days/project-code-quality-remediation-evidence/desktop/changed-files.txt`.
- Earlier targeted batches and the expanded owner/supersession regression outputs are retained in the same task-owned scratch directory. Logs have repository prefixes removed. Scratch is intentionally non-final evidence for lead integration.

### Limits and handoff

No live Browser automation, provider/credential access, live database/transcript access, host application/window/listener mutation, installation/deployment, native rebuild, Git commit/index/ref mutation, or delegation occurred. Browser windows and ownership tests use fake Electron objects; the existing broker tests use isolated fixtures. Real OS focus/visibility behavior has not been smoke-tested. A show request whose renderer cannot complete presentation within five seconds reports invisible and leaves the tab available for manual IAB use.

The lead still owns full typecheck/test/build, acceptance, final archives/indexes, and host restart coordination. Main/preload changes need a subsequently authorized restart to affect the running development instance; no restart was performed. No outstanding write-set expansion or implementation blocker remains.
