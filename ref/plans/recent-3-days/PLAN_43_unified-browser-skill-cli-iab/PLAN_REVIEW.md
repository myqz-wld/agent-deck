# Final plan self-review

## Scope

Reviewed the complete durable plan, confirmed decisions, four spike reports, CLI v1 contract,
Local/Remote architecture, WebContentsView parking route, annotation, prompt scope, task graph,
validation, rollback, and cold-start readiness.

## Findings and resolutions

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| PR-1 | HIGH | A persistent invisible parking BrowserWindow changes `BrowserWindow.getAllWindows()` and could prevent Dock recreation/non-macOS quit or make second-instance handling show the wrong window. | Plan now requires explicit FloatingWindow/window-role lookup for all user-presentation/count paths and platform lifecycle tests. |
| PR-2 | HIGH | Renderer-provided WebContentsView bounds could let untrusted page content cover Agent Deck header, tabs, composer, another session, or outside-window space. | Main owns a generation-scoped presentation lease and intersects every bounds request with the current trusted content region/session/tab. |
| PR-3 | HIGH | Disabling Codex BrowserUse may remove its implicit `/tmp/codex-browser-use` sandbox allowance, breaking CLI sockets or encouraging broad network enablement. | Plan requires only the exact broker socket through supported Codex Unix-socket permission configuration and blocks cutover if managed requirements/live sandboxes cannot prove it. |
| PR-4 | MEDIUM | CLI help/tool descriptions could silently expand the seven-file prompt scope. | `--help` is mechanically generated syntactic schema output only. Full trigger, semantic, safety, and recovery guidance remains in the three authorized skills; a new prose reference still requires scope expansion. |
| PR-5 | MEDIUM | Remote provider private-path/Workspace ceilings may prevent a safe shim/socket projection. | T6 treats this as a hard done criterion; current MCP tools remain the fallback and Remote unification cannot be claimed without live proof. |
| PR-6 | MEDIUM | Opacity-zero view behavior is proven only on the current macOS/Electron/Retina environment. | Cross-platform, multi-view, lifecycle, Spaces/taskbar, energy, and installed-app acceptance remain explicit gates; popup fallback is forbidden. |
| PR-7 | MEDIUM | Annotation could transmit a screenshot without a deliberate message action. | Complete adds a PNG only to the existing composer; it never auto-sends. Unsupported runtimes show a reason and no controls. |
| PR-8 | LOW | T8 lists T1-T7 while its task record directly blocks only on T7. | Accepted: T7 is transitively blocked by T2/T4/T5/T6, which themselves depend on T1/T3. The plan retains the complete logical dependency statement. |

## Checkpoints

- Checkpoint A: passed; every route-changing known user decision D-101 through D-106 is confirmed.
- Checkpoint B: passed; spikes changed the engineering parking implementation but introduced no new
  user-owned product, security, persistence, or scope decision.
- Checkpoint C: passed after PR-1 through PR-7 were incorporated into the plan. No user-owned item is
  unresolved and no prompt path outside D-106 is authorized.

## Handoff readiness

- Base commit and clean main state are recorded.
- Eight pending Agent Deck tasks have dependency ids.
- Spike artifacts and remaining acceptance risks are indexed.
- Final plan approval is still required before worktree entry, backup, production edit, or task
  activation.
