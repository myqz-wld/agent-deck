---
plan_id: 43
completed_at: 2026-08-18
status: completed
base_commit: 7834daeabf453a9a5f38e0e0008873d807255382
---

# PLAN_43_unified-browser-skill-cli-iab: Unified Browser skill, CLI, and IAB

Status: completed with the Remote live gate intentionally retained
Completed At: 2026-08-18
Owner: user
Implementation authorization: granted on 2026-08-18
Isolation: detached Agent Deck worktree from the frozen base commit

## Goal

Give interactive Claude Code, Codex CLI, and Grok Build sessions one Agent Deck-owned Browser path:
a built-in skill invokes a deterministic CLI, the host binds that CLI to the authenticated
application session without model-supplied identity, and the session's private pages appear in a
conditional responsive IAB with annotation through the existing composer.

## Confirmed route

- Use one bundled Browser skill plus `agent-deck-browser` for all three adapters.
- Deliver identity through a session-scoped command shim and Browser-only lease. Never depend on the
  model passing an Agent Deck or provider session id.
- Cover Local and Remote in stages. Remove Local conflicting surfaces after parity, but retain the
  independently owned Remote MCP fallback until live Remote acceptance passes.
- Follow each adapter's existing Agent Deck Skills switch. Oneshots remain Browser-free.
- Treat the installed OpenAI Browser plugin and `~/Repository/codex` as read-only behavioral
  references, never runtime dependencies.
- Show IAB immediately after Cross-session only while the session has a tab. Use inner tabs for
  multiple pages, keep work background-first, and follow the current narrow panel responsively.
- Let the user resize the app manually; never auto-maximize or widen it for Browser work.
- Freeze the page for pen/circle annotation and add one PNG to the existing composer without
  auto-send. Hide annotation and explain the reason in-page when PNG input is unsupported.

## Invariants

- Public CLI argv and operation payloads cannot choose session authority.
- Browser cookies, storage, tabs, views, artifacts, and leases remain session-private and
  lifecycle-bound.
- Page content and diagnostics are untrusted evidence, not instructions or permission.
- Snapshot refs are generation-bound; navigation, reload, or a newer snapshot invalidates them.
- Native views never give page content Node access and remain parked/background unless explicitly
  presented.
- Local and Remote state are source-qualified; Remote cannot fall through to Local.
- The composer remains the sole send/queue/steer authority.

## Task breakdown and evidence

| Task | Result | Commits |
|---|---|---|
| T1: operation and lease core | Versioned operations, schemas, executor, browser-only lease registry, spoof/replay tests | `0acd4bbf` |
| T2: packaged CLI and Local contexts | Strict CLI, broker, private shim/context, Skills gating, sandbox projection | `06522945` |
| T3: WebContentsView and parking | Hardened tab surface, inactive parking host, presentation lease and real Electron fixture | `9a3e28b1` |
| T6: Server Core/Remote | Pure-Node Core runtime, provider projection, Desktop broker, safe screenshot artifacts | `57e25251`, `30129f18` |
| T4: Session Detail IAB | Typed IPC/preload, Local/Remote state, conditional outer IAB, inner tabs, responsive bounds | `e35aea83` |
| T5: annotation and composer | Frozen physical PNG, bounded drawing, invalidation, Local/Remote attachment handoff | `8579bcc9` |
| T7: skills and cutover | Three identical skills, aligned docs, all Local legacy surfaces retired | `126b3033`, `8a89c270` |
| T8: integrated acceptance | Full tests/builds/review/records; Remote live gate retained without configured target | final records commit |

## Validation

- Prompt inventory and manifest-backed backups covered the exact seven approved prompt assets.
- Prompt/resource tests passed 40 checks; Local cutover tests passed 82 checks.
- TypeScript and architecture gates, real Electron Browser fixture, the full test suite, main/preload/
  renderer build, logger policy, Linux headless reproducibility, amd64/arm64 Feishu runtime builds,
  deployment static checks, and diff hygiene passed.
- The ordinary full run skipped only existing opt-in live files.
- Explicit Remote live acceptance stopped before mutation because
  `AGENT_DECK_PROVIDER_LIVE_DOCKER_HOST` was absent. No external target was guessed or created.

## Final status and handoff

The implementation is complete and Local sessions have one authoritative skill + CLI route. The
Server Core Remote MCP fallback remains deliberately enabled and documented. Removing it is a later
evidence-gated cutover requiring a configured live Remote target covering CLI, IAB, screenshot,
annotation, disconnect/reconnect, and generation retirement.

The archived review is
`ref/reviews/recent-3-days/REVIEW_255_unified-browser-boundary-review.md`; the user-visible record is
`ref/changelogs/recent-3-days/CHANGELOG_618_unified-browser-skill-cli-iab.md`.

Durable planning evidence is preserved beside this plan in
`PLAN_43_unified-browser-skill-cli-iab/`: the approved plan review plus the CLI identity,
WebContentsView parking, annotation, and Remote parity spike reports. Executable spike scripts and
private fixture scratch were intentionally not archived because production tests supersede them.
