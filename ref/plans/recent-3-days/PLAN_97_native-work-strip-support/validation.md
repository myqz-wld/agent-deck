# Native work integration validation

Status: implementation and final required checks complete; local submission on `feat/native-work-strip`.
Baseline: `e4f4a08c75439be07b342163e78ddac3e1aca08d`.
Owner: lead only; no delegated work or reviewer sessions.

## Targeted evidence

- Real SQLite tests exercise independent task discovery after 250 parent events, replay/revision
  stability, opaque attempt ordering, Unicode chunks/pages, parent/child tool isolation, shorter
  output replacement, ownership rejection and session deletion cascade. Runtime epoch tests cover
  revision reset in a fresh runtime and rejection of late old-runtime updates.
- Provider tests cover Claude foreground agents, pre-registration buffering and exact stop;
  Codex launch/parent completion, child/terminal ownership, fresh turn/process-item validation,
  output and process-generation boundaries; Grok truncated membership, isolated child context,
  old attempts, owner/epoch checks and cancellation versus not-found/already-finished outcomes.
- Contract/service/Core tests cover bounded inputs, cross-owner responses, workspace/grant checks,
  unsupported/stale references, duplicate stop coalescing, timeout and disconnected history.
- All 21 approved prototype gesture tests run against the production gesture hook. Eight production
  interaction tests cover empty rendering, terminal-confirmed hiding, stop failure/timeout recovery,
  separate stop behavior, new attempts, scoped remembered state, Markdown/plaintext and first-mount
  measurement of remembered expanded cards. Ingestion plus production disclosure checks passed
  54 targeted tests after attaching durable event IDs to live parent rows.
- Answer durability: 2 tests first failed, then 41 targeted tests passed; see REVIEW_333.
- Initial full suite: 7,509 passed, 6 skipped, 1 failure in old Remote grant bit compatibility.
  New methods and grant entries were moved to the append-only tail. The captured older grant
  fixture now retains the same methods and acquires none of the new native-work permissions.

## Browser evidence

Only the bundled session-scoped `agent-deck-browser` CLI was used. The production-component
preview was loaded from `.ref/prototypes/native-work-production/index.html` in a background tab.
It uses the real SessionDetailShell, ActivityRecordsView, SessionComposerView and native-work
components, with synthetic provider data and stop responses.

- Measured all cards at 440 CSS pixels. The strip reserves 77 pixels when present.
- Expanded details measured 156.125 pixels, equal to the visible conversation height cap.
  Collapsing an output record reduced the panel to 105.25 pixels without moving the composer.
- Empty mode removed the entire strip and increased conversation height from 156.125 to 233.125.
- A simulated rejected Stop exposed retry. Retry received a synthetic terminal notification and
  retained all five cards, with one stopped card and no remaining error notice.
- Reload retained the expanded task and its collapsed output disclosure. The first-mount popup
  ref timing defect observed during this check was fixed and regression-tested.
- Screenshot inspection confirmed the existing session-detail/composer layout and upward overlay.

Coverage limits: synthetic Browser actions do not cancel real work. The CLI has no drag command;
free dragging and edge auto-scroll have DOM gesture-test coverage, not native pointer automation.
No live inference, task cancellation, application restart, installation replacement or remote push
was performed. Final Browser console/scope checks and submission status are recorded below.

## Final checks and submission

- `pnpm typecheck`: exit 0; architecture checks and both TypeScript projects passed.
- `pnpm test`: exit 0; 7,515 passed, 6 skipped; 1,195 files passed, 3 skipped.
- `pnpm build`: exit 0; main, preload, renderer and build metadata generated.
- `git diff --check`: passed. Schema SQL/version files remain unchanged.
- Changed sources/records and built JS/CSS/HTML/JSON/native artifacts contained no personal
  home/worktree identifiers in the targeted privacy scan. No distribution archive was produced.
- Pure Core ingestion helpers and feature composition were extracted. Two 505-line provider
  facades have documented scope-specific protection in CHANGELOG_686.
- The review-expiry helper ran and exited 1 while listing historical coverage; this does not
  constitute an independent review. New source and all scoped changes received lead inspection.
- Final Browser checks verified terminal-card keyboard dismissal, retained execution history and
  restoring the card from Tasks. Popup/output disclosure survived reload. The preview is left open
  intentionally. Claude, Codex and Grok fixture labels render through the same production strip;
  Local/Remote fixture modes do not imply a live Remote network test. Final console capture
  returned no entries; the Grok/Remote fixture remains open with its first card expanded.
The original checkout was inspected: no commits newer than the baseline; its preserved Claude
repair and REVIEW_331 edits remain dirty and untouched. Git author/committer match the repository's
recent public identity. The managed ref archive hook is present. No record bucket moves were
needed for the current date. Original and production previews are intentional non-final material;
generated static provider schemas are private temporary scratch outside the worktree.

The staged privacy scan passed for all 104 scoped files. No scratch, generated provider schema,
build output, credentials or machine identifiers entered the index. The advisory hook retains
the two intentional prototype workspaces. The local commit is retained on the named regular
branch; the original checkout and installed application remain unchanged.
