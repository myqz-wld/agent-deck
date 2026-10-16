---
changelog_id: 686
changed_at: 2026-10-15
---

# Native subagent and background task strip

## Summary

Claude, Codex and Grok native work now has a separate task strip above the existing composer.
The approved interaction, retained execution history, client preferences and exact task controls
are implemented for Local and Remote sessions. Empty task lists reserve no space. The earlier
Claude child-event isolation repair remains included.

## Changes

- `src/contracts/native-work.ts` and `src/shared/native-work.ts` define validated session/provider/entity,
  attempt and runtime identities. Runtime observation epochs reject old-generation tails without
  sorting opaque Codex or Grok IDs. Claude retains its documented lexical run ordering.
- `src/main/store/native-work-repo.ts` reuses events, revision triggers and parent deletion cascades.
  Current tasks and retained attempts are paginated independently of the recent main feed. Child
  records use separate identities, 16 KiB UTF-8 text chunks and 16-record detail pages. Replay
  does not duplicate rows; shorter replacements remove obsolete tails. Schema SQL/version 62
  is unchanged. Parent pagination filters child details and normalized task snapshots before LIMIT.
- Provider observers retain child activity beyond foreground completion. Claude maps the SDK's
  parent tool markers and reads only registered output references or explicitly scoped native
  transcripts with matching invocation markers. Codex observes owned child threads, current turns,
  background terminal pages and incremental output through generation-scoped live requests.
  Grok isolates child translation and consumes native lifecycle/snapshot extensions and typed
  cancellation results. Truncated snapshots do not clear active work.
- Local IPC/preload and Core/Remote list/detail/stop methods share read/write grants and session
  ownership validation. Remote text uses existing private-path/secret projection. Grant policy
  revision 3 appends method bits, preserving earlier releases' grants without giving them new rights.
  Controls never infer ownership from a PID, start a runtime to stop stale work, or substitute a
  parent interrupt. Missing control support and detached history remain explicit.
- Production components implement 440px cards, horizontal wheel scrolling, free-direction
  reorder/dismiss gestures, edge scrolling and independent upward details. Vertical dismissal
  requires more than 80px outside the strip; horizontal tolerance is 28px. Strip scrolling and
  dragging collapse details; internal detail scrolling does not.
- Dragging active work out hides it provisionally; only a terminal confirmation commits hiding.
  Failure or timeout restores the card and exposes retry. The separate Stop control retains its
  card. Output defaults to the existing safe Markdown renderer. Tasks contains an independent
  execution-history section, including hidden attempts, with an option to show current cards again.
- Client/host/session preferences contain IDs, ordering and booleans only. Card/message/tool
  expansion survives remount/restart and new attempts reappear. Preference storage bounds retained
  scopes and entries. Live parent events receive their durable event ID before publication so
  disclosure identity survives reload without hashing streaming text.
- Confirmed answer durability defects are repaired separately in
  [REVIEW_333](../../reviews/recent-3-days/REVIEW_333_answer-durability.md).
  README contains only the feature and concise usage instructions.

## Validation

Final verification is recorded in
[PLAN_97 validation](../../plans/recent-3-days/PLAN_97_native-work-strip-support/validation.md).
The initial full run found one grant directory ordering failure; moving new method bits and their
grant entries to the append-only tail fixed the compatibility issue. Focused tests also caught
an initially unmeasured remembered popup on remount; the card now resolves its DOM parent before
the strip ref is attached. Neither failure was bypassed.

## Do Not Split Protection

The implementation extracts model/storage, provider observers, transport, UI, preference and
history logic into focused modules. Core ingestion's pure registration helpers were extracted to
`src/hosts/server-core/session-manager-ingest-helpers.ts`; native-work Core composition is owned by its
feature module. Two existing provider facades remain at 505 lines:

- `src/main/adapters/codex-cli/sdk-bridge/index.ts`
- `src/main/adapters/grok-build/bridge.ts`

Their six new lines only forward list/stop to extracted observer modules while preserving private
runtime maps. Moving these accessors alone does not separate another lifecycle responsibility;
further constructor/facade decomposition would touch unrelated recovery/control wiring. Revisit
when either facade's constructor or lifecycle surface next changes. No new implementation module
exceeds 500 lines.

## Limits and activation

Native source/protocol and fake transport tests establish contracts, not live provider inference
or cancellation. Provider output can be upstream-truncated or unavailable; registered local file
snapshots are capped at 1 MiB and explicitly marked partial. Native history import is bounded;
unattributable earlier-run content is not imported into a current attempt. No arbitrary client
file path or private provider control API is exposed.

Browser validation uses production components and synthetic data. Real pointer dragging and edge
scrolling are covered by gesture tests because the session Browser CLI has no drag command. The
new preview remains intentionally non-final under `.ref/prototypes/native-work-production/`, and
the original ten-file prototype is preserved. Generated provider schemas are scratch, not release
inputs. No package, installed app, running host process, shared native binding, or remote ref was
changed. Activation requires a separately authorized main/preload runtime restart or installation.
