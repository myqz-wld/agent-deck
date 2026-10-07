---
completed_at: 2026-10-07
---

# Image upload stall investigation and repair

## Goal and constraints

Investigate the confirmed Codex new-session image stall and implement persistence deadlines,
safe late-write cleanup, and stage diagnostics. The user authorized source investigation and
repairs; live application replacement/restart remains subject to separate exact-target approval.
Keep draft input and Gateway selection on failure, never dispatch timed-out input later, and
record only sanitized diagnostic metadata.

## Completed work

1. Correlated the confirmed request with the attachment-persistence phase and earlier config-open
   timeouts. Checked installed metadata, the current process, and prior filesystem incidents.
2. Reproduced broad asynchronous filesystem starvation in a disposable native process. Kept the
   historical cause explicitly unproved because the original process had already exited.
3. Added one 10-second message-level persistence deadline, exclusive file ownership, bounded
   writes, late-completion fences, and one-second cleanup waits.
4. Added privacy-preserving phase/resource diagnostics and a coalesced callback filesystem probe.
5. Verified late mkdir/open/write/close behavior, partial writes, rollback stalls, retries, and
   renderer draft preservation. Ran typecheck, the complete test suite, and a build.

## Validation and final status

- Typecheck and build passed; full tests passed 1,138 files / 7,072 tests with existing optional
  and platform skips. SQLite binding unchanged.
- Production code and tests remain below 500 lines. Temporary diagnostics are not distribution
  inputs. No provider credentials or personal filesystem prefixes are retained.
- Source repair is complete. Installed-runtime activation remains pending; an original native
  blocker can only be attributed with new failure-time diagnostics and a pre-restart stack sample.

Final record: [Image upload stall review](../../reviews/recent-3-days/REVIEW_315_image-upload-stall.md).
