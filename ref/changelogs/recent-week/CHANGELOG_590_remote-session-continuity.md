---
changelog_id: 590
changed_at: 2026-08-11
---

# CHANGELOG_590_remote-session-continuity: Complete Remote session continuity

## Summary

Remote session detail now keeps Worker-owned context, handoff, runtime input, and adapter-native
image behavior aligned with Local presentation. Protocol 2.3 exposes the new surfaces only after
minor-version negotiation, while unsupported provider behavior remains explicit and fail closed.

## Changes

- Add protocol 2.3 capabilities for Worker-owned context snapshots, session-scoped active-turn
  input policy, and Remote handoff preview/commit.
- Implement identity-fenced Remote handoff with Worker Workspace authority, bounded preview
  binding, idempotent commit, durable terminal results, resource transfer, and successor-scoped
  source-finalization notices.
- Surface context-window usage only when the Worker reports a matching adapter/runtime identity;
  reset snapshots across compaction and never fall back to Local usage.
- Support active-turn text and images according to provider-native behavior: Claude queues messages,
  Codex steers with native local-image input, and Grok interjects images only when the selected live
  ACP session negotiated `promptCapabilities.image=true`.
- Remove the extra detail-level Pending and Runtime tabs from both Local and Remote. Runtime
  controls remain above the shared composer and the global Pending page remains available.
- Add optional managed macOS Provider Supervisor deployment, bounded mode-0600 Grok credential
  projection, official check/dry-run/deploy/upgrade/verify gates, and wrapper-controlled Worker
  restart sequencing. Linux retains its explicit systemd-user/manual lifecycle.
- Terminalize Grok ACP transport-recovery failures so a recovery explanation emitted after a
  completed turn cannot move the session back to a permanent `working` state.

## Validation

- Final `pnpm test` passed 901 files and 5,789 tests; 2 files and 3 tests were skipped.
- `pnpm typecheck`, `git diff --check`, production build, Linux headless/deployment verification,
  macOS Worker sandbox verification, and packaged macOS Worker verification passed.
- `pnpm dist:mac` produced an exact clean-commit arm64 package for
  `1d08bedddc8ccf20803a51a166edbf61596dbf18`.
- Paired Claude/Codex deep review converged after fixing terminal handoff scope races, per-session
  Grok image authority, Relay documentation gates, and successor-scoped notice handling. Details
  are recorded in `REVIEW_230_remote-session-continuity.md`.
- Feature commit `581008511418c77e1a59419f87a1999e82c01356` and Grok terminal-recovery fix
  `1d08bedddc8ccf20803a51a166edbf61596dbf18` were pushed to `origin/main`.

## Deployment and live acceptance

- The installed application reports exact clean commit `1d08bedd`. The official Worker check and
  dry-run passed; independent verification reports Worker
  `worker-df9dfaddfd410be3979119c7` and Provider Supervisor `aws-relay-on-mac` running.
- The official Relay upgrade completed as release `git-1d08bedddc8c`; the content-equivalent Relay
  image remains digest
  `localhost/agent-deck-relay@sha256:5a283579603442bde6e66fab436aa9a3e52e18feeb3d5086fdf45def76039d6f`
  and independent verification reports healthy.
- A fresh protocol 2.3 Client received 26 capabilities from authoritative Core
  `aws-relay-on-mac:66770:4d6e4885-3b30-41ff-ac20-55ebce1f8c22`, confirmed all three adapters
  enabled, and read the final Claude, Codex, and Grok sessions as `active-finished`.
- Claude session `a03c9ef3-9b8e-4b63-b682-615fe72209b4` used
  `deepseek / deepseek-v4-flash[1m] / max`, returned `CLAUDE_DEEPSEEK_FINAL_OK`, and advertised
  active-turn `queue` with images enabled.
- Codex session `019ff181-dc5b-7ed2-acbd-685bd9c9955a` used `gpt-5.6-sol / low`, returned
  `CODEX_GPT_5_6_SOL_FINAL_OK`, and advertised active-turn `steer` with images enabled.
- Grok session `f009c96d-ae08-4f06-82d5-beae8c734a06` reached the real xAI endpoint through the
  managed container, broker, and projected OAuth credential. xAI returned `402 Payment Required`,
  but the fixed runtime correctly settled at `active-finished`. Grok ACP 0.2.118 advertised
  `interject` with images disabled because that live session did not negotiate image input.
- Colima exposes only the exact Provider private root and isolated Worker Workspace required by the
  managed container. No Provider container remained after acceptance; failed pre-mount diagnostic
  directories were moved to the Trash and remain recoverable.

## Operational notes

- The OAuth projection contains a bounded access credential and expiry, not the native Grok refresh
  document. It must be refreshed through the official credential/deployment flow after a new
  `grok login`, or replaced by a paid long-lived xAI API credential.
- The final Worker `upgrade` invocation reported `launchctl` exit 5 at its last kickstart even
  though the newly installed exact-commit Worker was already running. The official `verify` gate
  and a fresh Remote Core identity proved the desired runtime active; no direct signal or forced
  restart was used.
- Grok image input is implemented but capability-driven. The current pinned ACP runtime reports it
  unavailable, so the UI correctly remains text-only for Grok until ACP negotiates image support.

