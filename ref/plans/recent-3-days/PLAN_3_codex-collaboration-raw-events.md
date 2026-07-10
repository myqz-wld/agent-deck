---
plan_id: PLAN_3
created_at: 2026-07-10
completed_at: 2026-07-10
status: completed
related_review: REVIEW_147
---

# PLAN_3_codex-collaboration-raw-events: Restore Codex collaboration events

## Goal

Determine why Agent Deck persisted every visible Codex collaboration activity as `wait_agent`,
prove the first disappearance boundary with metadata-only evidence, and implement the smallest safe
repair without changing tool-name normalization.

## Invariants

- Preserve the native rollout, production SQLite database, and unrelated user work.
- Treat native JSONL and SQLite rows as evidence only.
- Do not assume reinstalling commit `99b4a2e` fixes the defect; the installed build already contains
  its collaboration translator.
- Diagnose app-server delivery, translation, merge, and persistence before editing.
- Do not expose full collaboration messages or prompts in diagnostic output.

## Completed Work

### Native and persisted evidence

- Counted 4 `spawn_agent`, 4 `send_message`, 5 `list_agents`, 2 `followup_task`, and 9
  `wait_agent` native calls for session `019f4ac1-731c-7463-a152-60496bc90edb`.
- Confirmed SQLite contained only 9 normalized wait start/end pairs.
- Traced missing spawn call `call_qxdJfvIQUhu1ZI4ytIS2wISK` and retained wait call
  `call_zBQVRMuU9XynFlI7y4W8gdux` by metadata and exact call ID.

### First disappearance boundary

- Verified Agent Deck's client dispatch, thread queue, translator, SessionManager ingest, payload
  merge, and SQLite identity rules cannot selectively remove or rename the spawn call.
- Inspected exact Codex 0.144 source and found that raw response items are discarded in the thread
  listener unless `thread/start.experimentalRawEvents` is true.
- Confirmed `initialize.capabilities.experimentalApi` permits the experimental field but does not
  enable raw events.
- Confirmed MultiAgentV2 separately normalizes waits, explaining why only they survived.

### Live protocol proof

- Ran a `/tmp`-only, metadata-sanitized app-server A/B harness with ephemeral threads.
- Raw enabled delivered a `list_agents` function call and output; raw disabled delivered zero raw
  response notifications. No normalized collaboration item existed for `list_agents`.

### Repair

- Added the raw-event opt-in to newly started Agent Deck Codex threads.
- Added focused request-construction regression coverage and retained existing raw translator/merge
  coverage.
- Deliberately left normalization, merge, persistence, resume, and fork request code unchanged.

## Validation

- Focused app-server tests: 2 files / 14 tests passed.
- `pnpm typecheck`
- `pnpm test` — 205 files / 2244 tests passed.
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`
- File-level review expiry audit completed.

## Residual Risks and Follow-up

- Codex 0.144 exposes the opt-in only on `thread/start` and hardcodes raw events off for cold resume
  and fork listeners. Universal post-restart coverage requires an upstream protocol addition or a
  separately planned native-history fallback.
- The active installed application was not restarted or overwritten. Rebuild/install and run one
  interactive collaboration turn after this session ends if installed-app confirmation is required.

## Final Status / Handoff

The observed fresh-session parsing defect is fixed at its proven source boundary. `REVIEW_147`
contains the full evidence and explicitly limits the claim to newly started threads.

Completed At: 2026-07-10
