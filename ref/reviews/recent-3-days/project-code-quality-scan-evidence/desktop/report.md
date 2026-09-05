# Desktop project scan — 2026-09-04

Track: desktop. Invocation: `2026-09-04-project-scan`. This is an ordinary independent scan, not a paired review or approval verdict. Source and Git were read-only; all evidence is in this report's temporary directory.

Exact baseline/final HEAD: `072dd7a284eebc2752dab7e5d5505aa2ee480b77`, branch `main`. `git status --short` was empty both before and after the scan.

**Results**

| ID | Classification | Severity | Confidence | Result |
| --- | --- | --- | --- | --- |
| desktop-01 | Trust-boundary defect | HIGH | High for source/command construction; Windows execution not exercised | A custom sound filename becomes executable PowerShell syntax. |
| desktop-02 | Functional defect | MEDIUM | High | Returning to a Local Diff tab does not fetch changes made while another tab was active. |
| desktop-03 | Functional defect | MEDIUM | High | Incremental Diff refresh can permanently hide revisions beyond its first page. |
| desktop-04 | Functional defect | MEDIUM | High | An earlier Remote source choice can overwrite a later Local choice. |
| desktop-05 | Functional defect / incomplete integration | MEDIUM | High | Browser `open --show` returns `visible: true` but the production view remains parked. |
| desktop-06 | Architecture opportunity linked to desktop-02/03 | LOW | High | Local/Remote Diff loaders duplicate a state machine and already differ in cursor/revalidation behavior. |

**desktop-01 — Custom sound file names cross into executable PowerShell source**

Primary location: `src/main/notify/sound.ts:146`; execution sink: `src/main/notify/sound.ts:155`.

```ts
const uri = 'file:///' + file.replace(/\\/g, '/');
const escaped = uri.replace(/`/g, '``').replace(/"/g, '""');
const psScript =
  'Add-Type -AssemblyName PresentationCore;' +
  '$p = New-Object System.Windows.Media.MediaPlayer;' +
  `$p.Open([Uri]::new("${escaped}"));` +
```

Trigger/boundary: on the supported Windows desktop target, the user selects an existing audio file whose name contains a PowerShell subexpression, for example `$(Write-Output SCAN_MARKER).wav`. The filename is data from the sound picker, not an executable selection. The current escaping preserves `$()` inside a double-quoted PowerShell string; a command-bearing subexpression is evaluated by PowerShell. An attacker controlling a supplied audio filename can consequently cause code execution with the desktop user's authority when the user previews that sound or a notification plays it. Ordinary filenames containing `$name` can also be expanded incorrectly and fail to play. This is not a claim that an unauthenticated remote caller can change settings.

Production chain: `src/renderer/components/settings/controls.tsx:215` (`SoundPicker.choose`) → preload `chooseSoundFile` → `src/main/ipc/window-app.ts:30` native audio picker → `NotifySection` setting update (`src/renderer/components/settings/sections/NotifySection.tsx:33`) → `SettingsSet` → `playTestSound` / `src/main/notify/visual.ts:23` → `playSoundOnce` → `playFile` → `execFile('powershell', ['-NoProfile', '-Command', psScript])`. `package.json` includes a Windows packaging target; this is a current supported platform path.

Verification: `windows-sound-reproduction.test.tsx:12` imports the actual sound module with Windows platform constants, settings, filesystem existence, and child-process creation mocked. It confirms that the command reaches the mocked `execFile` with an unescaped `$()` expression embedded in `[Uri]::new("...")`. No command or sound was executed. Microsoft documents evaluation of subexpressions inside double-quoted strings and literal handling in single-quoted strings. [PowerShell 5.1 quoting rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules?view=powershell-5.1#double-quoted-strings).

Counter-evidence/limits: `existsSync` requires an existing file, and a user must choose it; this does not remove the data-to-code boundary. `execFile` avoids an outer shell but explicitly launches a PowerShell interpreter with generated source. macOS/Linux use argument arrays and are unaffected by this particular bug. `pwsh` is not installed in this environment; native Windows execution remains untested.

Fix direction: keep the PowerShell script constant and pass the path through a data-only parameter/environment channel, or correctly encode a literal PowerShell argument including apostrophes and URI handling. Add a Windows-oriented regression with `$`, `$()`, spaces, and apostrophes. No compatibility retirement or user architecture decision is needed to preserve sound selection safely.

**desktop-02 — Local Diff stays stale after switching tabs**

Primary location: `src/renderer/components/SessionDetail/use-file-changes.ts:71`; unsubscribe boundary at lines 76–90.

```ts
useEffect(() => {
  if (!enabled || changes !== null) return;
  void loadFirstPage(false);
}, [changes, enabled, loadFirstPage]);
```

Ordinary trigger: open a Local session's Diff tab once, switch to Activity/Tasks while the same session changes files, then return to Diff after the agent finishes. `enabled` is `tab === 'diff'` (`src/renderer/components/SessionDetail/index.tsx:84`). While disabled, the hook removes its `onAgentEvent` listener but retains `changes`. Re-enabling skips the initial read because that retained list is non-null. No later event is needed to occur after the agent finishes, so the stale file list and selected diffs can remain indefinitely; there is no normal refresh button in the successful list state.

Production chain: Local `SessionDetail` retains its `useFileChanges` hook while `SessionDetailShell` changes the visible tab → typed preload `listFileChangePage` (`src/preload/api/sessions.ts:58`) → `SessionListFileChangePage` (`src/main/ipc/sessions.ts:44`) → `fileChangeReadRepo.listSummaryPage`. Live `file-changed` events are bridged through `src/main/index/bootstrap-wiring.ts:141`; the global session store does not refresh this hook's private list.

Verification: `flow-reproductions.test.tsx:10` uses the actual hook, starts with revision 1, disables it, changes the simulated repository response to revisions 2 and 1, and re-enables it. The list method was called only once and the hook still exposes `[1]`; the same IPC stub would return `[2,1]` if requested. Existing `use-file-changes.test.tsx` passes but has no leave/change/re-enter case.

Counter-evidence: changing session/cwd resets the hook and loads new data; another `file-changed` event after returning also refreshes it. Those do not cover returning to the same session after the work has completed. No source/profile leakage is claimed.

Fix direction: refresh on a disabled→enabled transition or keep a lightweight per-session dirty revision subscription while hidden and revalidate on return. Preserve deliberate history selection and pagination. No product decision is required.

**desktop-03 — A multi-file burst can leave Diff revisions unreachable**

Primary location: `src/renderer/components/SessionDetail/use-file-changes.ts:59`.

```ts
setChanges((current) =>
  incremental && current ? mergeSummaries(current, page.items) : page.items,
);
setNextCursor((current) => (incremental ? current : page.nextCursor));
```

Supported trigger: the currently loaded Local Diff list is exhausted (`nextCursor === null`, e.g. one prior change). A Codex `fileChange` completion reports 51 additional file changes in one batch. The production translator loops over the entire supported `item.changes` array and emits each change (`src/main/adapters/codex-cli/app-server/translate.ts:279`). The UI coalesces these notifications for 300 ms, fetches only the first 50 changes, merges them into the prior list, and discards the returned cursor because the load is incremental. In a concrete 52-row example it shows IDs 52 through 3 plus ID 1, loses ID 2, reports `hasMore: false`, and offers no way to fetch the missing row in the current view. No unusually large installation or unsupported provider version is assumed; 50 is the implementation's normal page size.

Production chain: Codex `fileChange` completion → per-file `file-changed` event → session ingestion and normal `AgentEvent` bridge → `useFileChanges` debounce → `SessionListFileChangePage` → summary page and non-null `nextCursor` → cursor discarded. A pre-existing older cursor can similarly skip a gap when the new head page does not overlap the loaded range.

Verification: `flow-reproductions.test.tsx:66` uses the actual hook, immediate paginated IPC responses, a completed initial read, 51 event notifications, and the actual 300 ms debounce. It observes 51 displayed rows out of 52, missing ID 2, a false `hasMore`, and no request when `loadMore()` is invoked. This reproduction does not depend on reordering asynchronous SQLite IPC responses.

Counter-evidence: the existing test covers an overlapping small refresh and intentionally preserves the old exhausted cursor; that is safe only when the refreshed page overlaps all unseen records. Remote Diff already adopts a returned cursor when the prior one is null (`src/renderer/components/SessionDetail/RemoteDiffPanel.tsx:63`), although preserving a non-null old cursor still requires an overlap policy.

Fix direction: merge pages only when continuity is established, otherwise traverse the new head cursor until it overlaps loaded records, or reset the loaded paging window. Adopting a new cursor when the old one is null fixes the exhausted-list case but alone does not prove general gap freedom. No provider compatibility retirement is needed.

**desktop-04 — Source selection serializes individual calls but not user intent**

Primary location: `src/renderer/App.tsx:385`; queue implementation at `src/renderer/remote-host/use-remote-host-snapshot.ts:139`.

```ts
const profileId = value.startsWith('remote:') ? value.slice('remote:'.length) : '';
if (profileId) {
  void remoteHosts.selectProfile(profileId)
    .then(() => remoteHosts.setSourceMode('remote'))
    .catch((err: unknown) => logger.warn('[app] source switch failed', err));
}
```

Ordinary trigger: select a configured Remote profile and choose Local before the first selection completes. The Local mutation enters the shared `source-selection` queue while `selectProfile` is pending. When the earlier profile promise completes, its `.then()` appends `setSourceMode('remote')` after the newer Local mutation. The final persisted and displayed source is therefore Remote, contrary to the user's last selection. `AppHeader` keeps the source selector enabled while mutations are pending (`src/renderer/components/AppHeader.tsx:153`). Slow IPC or queued profile work makes this interval visible; there is no requirement for hostile input.

Production chain: `AppHeader` → `DeckSelect.selectOption` (`src/renderer/components/DeckSelect.tsx:109`) → App callback → `useRemoteHostSnapshot` `selectProfile`/`setSourceMode`, both on `SOURCE_SELECTION_MUTATION` → preload → `src/main/ipc/remote-host.ts:100` → `RemoteHostService.selectProfile/setSourceMode` (`src/main/remote-host/service.ts:225`) → profile-controller persistence. Ownership: desktop callback/hook; remote service files were followed only for context.

Verification: the disposable `source-selection-callback.ts` is generated from the actual App JSX callback by TypeScript AST extraction, not a handwritten approximation. `flow-reproductions.test.tsx:47` combines it with the actual hook and a deferred profile selection. It observes source-mode IPC calls `['local', 'remote']` and final Remote state despite Local being selected last. Existing hook tests exercise source changes individually and pass.

Counter-evidence: revision checks prevent older snapshots from overwriting newer ones, but the unwanted Remote mutation itself has a newer revision. Ignoring a response is insufficient because the underlying source is persisted incorrectly.

Fix direction: serialize one complete source-selection intent atomically or guard its second step with an intent generation before dispatch; alternatively expose an atomic select-source operation. Account for Local choices and choices from the profile manager in the same ordering boundary. No compatibility decision is needed.

**desktop-05 — Browser `--show` is an advertised operation with no production consumer**

Primary location: `src/main/browser-use/view-host.ts:189`; startup at `src/main/index/bootstrap-infra.ts:347`; success report at `src/main/browser-use/operation-executor.ts:163`.

```ts
this.showRequested = options.onShowRequested ?? (() => {});
```

Supported trigger: the user explicitly asks to watch Browser work and the session executes `agent-deck-browser open --show`. The CLI parser and bundled Browser instructions advertise this option. `executeOpen` calls `tab.show()`, which reaches `WebContentsViewTabSurface.requestShow()` and `BrowserViewHost.requestShow()`. Startup calls `initializeBrowserViewHost()` without an `onShowRequested` callback. Repository-wide symbol/call searches found no production call to `setShowRequested` and no production constructor callback. The request ends in the default no-op, while the operation returns `visible: true` purely from the requested boolean. The tab remains inside an opacity-zero, unfocused parking window; users must manually open the owning session's IAB tab.

Production chain: `resources/bin/agent-deck-browser.cjs:180` → authenticated CLI broker (`src/main/browser-use/browser-cli-broker.ts:59`) → `executeOpen` (`operation-executor.ts:151`) → `BrowserOwnerHandle.openTab` / `EngineTab.show` → `view-host.ts:103,224` → default empty callback. Renderer Browser state only adds an available IAB tab; it does not select/focus it (`src/renderer/components/SessionDetail/index.tsx:294`). This is the retained current CLI/IAB path, not the Browser front removed in REVIEW_267.

Verification: `browser-show-reproduction.test.tsx:7` uses the actual Browser operation executor, engine, and view host, with extracted existing test fake windows/views. It observes `ok: true`, `data.visible: true`, zero calls to `host.present`, and the tab still in the opacity-zero parking host. No real window, Browser session, listener, or application was created or changed. Existing view-host tests inject a fake callback, so they do not test production wiring; presentation-controller tests cover manual IAB presentation and pass.

Fix direction: connect show requests to an owner-qualified UI action that focuses the corresponding session and presents its IAB tab, and derive success visibility from the resulting presentation. If the product intentionally requires manual presentation, change the advertised option and result explicitly. User-owned decision for implementation: choose the exact foreground/IAB navigation behavior; background default and session isolation must remain intact.

**desktop-06 — Consolidate the duplicated Diff loading state machine**

Locations: `src/renderer/components/SessionDetail/use-file-changes.ts:20` (141 LOC) and `src/renderer/components/SessionDetail/RemoteDiffPanel.tsx:12` (215 LOC). These two production paths separately implement descending ID/timestamp merge, list/pagination generations, head refresh, cursor retention, load-more metrics, errors, and selected-payload/final-diff loading. Their existing cursor policies have already diverged: Local always keeps the previous cursor during an incremental refresh; Remote uses the returned cursor when the previous cursor is null. Their refresh triggers also differ in the user-visible way described in desktop-02.

This is a current maintenance/correctness cost, not a blanket request to unify Local and Remote authority. A shared list/payload state core with injected read functions and explicit revision/enabled identity can centralize continuity and stale-result tests, while each transport still owns its source identity, authorization, and error translation. Treat it as a fix opportunity linked to desktop-02/03, not an additional independent user-visible defect. Implementing the extraction is a separate authorized change; this scan does not request an approval workflow.

**Compatibility and unused-code classification**

- Confirmed obsolete production code: none established by this bounded scan after the same-day REVIEW_267 cleanup.
- Candidate incomplete surface: `BrowserViewHost.setShowRequested` has no production caller, but the corresponding advertised user action is live. This is desktop-05's missing integration, not a safe dead-code deletion.
- Necessary current protocol boundary: `LEGACY_BROWSER_OPERATION_NAMES` and `browserOperationFromLegacyName` remain consumed by `src/hosts/server-core/browser-cli-executor.ts:163` and `src/main/remote-host/remote-browser-executor.ts:67`, with Server Core MCP Browser registrations in `src/hosts/server-core/mcp-browser-tools.ts`. Their names do not establish obsolescence.
- Active test compatibility: `BrowserWindowTabSurface` / `EngineTabDeps.window` have active test and Electron fixture callers, including `scripts/fixtures/browser-engine-electron.ts:34`; production uses `WebContentsView` surfaces. They were not classified as unused production modules to delete.
- Explicit product/retention choices: the same-day audit's retained native identity/history/recovery paths, `FloatingWindow.flash`, and `swapLead` were not re-reported as obsolete. The deliberate `applyClaudeCliPath` no-op does not itself constitute an architecture defect; the CLI path is read on session creation.

**Coverage and verification**

- Inventoried all 689 primary tracked files, totaling 106,589 lines. `inventory.json` records path, byte/line count, and source/test/support classification; 254 files are tests/support under the scan's classification.
- Directly inspected selected source/test ranges in 112 distinct source/test files: 108 in the primary desktop inventory and 4 contextual files in other tracks. The exact repository-relative file list is `direct-inspected-files.txt`. These are file inspections, not claims of full-file or line-by-line coverage; some large reads were limited or truncated. `direct-inspection.tsv` records requested ranges and must not be treated as a line-coverage metric.
- Applied four `rg` sweeps to the complete inventory: async/lifecycle patterns (841 matches across 187 files), trust/IO/capability boundary patterns (850/175), compatibility/dead-code candidates (92/42), and dynamic/registration patterns (174/67). Match artifacts are beside this report. Symbol follow-ups also searched `src`, `resources`, and `scripts` for Browser creation/show callers and current Remote Browser registration. The lead owns the full production-entrypoint graph and integrated typecheck.
- Traced Local Diff activation/paging/events, Remote source choice through IPC/persistence, Browser CLI lease/owner/operation/presentation lifecycle, Electron host connect/disconnect/retirement, custom sound selection/playback, settings patch/apply/rollback, session creation/send attachment capability gates and handoff dispatch, attachment sidecars and lazy image loading, app startup/event bridging, and selected asset/mirror paths.
- No running/installed host state, credentials, live databases, or raw provider transcripts were inspected. No dependencies, bindings, package outputs, repository files, or Git refs were changed. No review skills, reviewer agents, delegation, deployment, or app lifecycle commands were used.

Focused existing tests (one worker; cache and temp roots redirected to this report's directory):

```sh
TMPDIR=/tmp/agent-deck-scan/2026-09-04-project-scan/desktop pnpm run test --config /tmp/agent-deck-scan/2026-09-04-project-scan/desktop/existing.vitest.config.mjs
```

Result: **4 files, 37 tests passed**. Files: `src/renderer/components/SessionDetail/__tests__/use-file-changes.test.tsx`, `src/renderer/remote-host/use-remote-host-snapshot.test.tsx`, `src/main/browser-use/browser-presentation-controller.test.ts`, and `src/hosts/electron/registry-lifecycle-races.test.ts`. The repository Electron-as-Node wrapper was used without changing native bindings. These tests use mocked desktop/runtime effects; SQLite tests were not required or run.

Disposable reproductions:

```sh
TMPDIR=/tmp/agent-deck-scan/2026-09-04-project-scan/desktop pnpm run test --config /tmp/agent-deck-scan/2026-09-04-project-scan/desktop/vitest.config.mjs --reporter=verbose
```

Result: **3 files, 6 tests passed**, where passing means the test successfully observed the current defective outcome. Five tests support desktop-01 through desktop-05. One supplemental synthetic deferred-initial-load test observes another lost-cursor path but is not a separate finding: the exact asynchronous reordering of the current synchronous production SQLite IPC handler was not established. The reported desktop-03 instead uses immediate responses and a normal completed-first-load multi-file burst. Test sources, extracted callback/fakes, configs, and final logs are retained here. Initial disposable harness setup errors in argument forwarding/module aliasing/temp realpath/mock interop were corrected without changing project code.

**Remaining limits**

This is not exhaustive dynamic, line-by-line, or security verification of all 689 files. Most renderer presentation components, issue/task/review dialog workflows, gateway configuration details, CSS/assets, native audio on Windows/Linux, native Electron navigation/input/annotation behavior, and every source/connection timing permutation remain below deep validation coverage. No live Browser test was run. The security conclusion uses actual command construction plus the primary PowerShell language contract, not a native Windows exploit run. Existing passing tests do not negate the isolated findings. Required integrated validation and deduplication across other tracks remain with the lead.
