---
changelog_id: 588
changed_at: 2026-08-11
---

# CHANGELOG_588_remote-worker-ui-authority: Align Remote UI and Worker authority

## Summary

Remote workspaces now use the selected Server Core and Worker as the authoritative source for
session controls, configuration, Hooks, assets, teams, issues, usage, and session totals. The
session detail shell and composer share the Local presentation while preserving adapter-native
Remote contracts and explicit capability limits.

## Changes

- Add protocol 2.2, minor-gated `node.configuration` and `node.assets` capabilities, and bounded
  Server Core methods for Worker provider defaults, Hook lifecycle, packaged assets, isolated
  Provider Home assets, and application conventions.
- Make Remote Settings read Worker defaults and install or remove provider Hooks inside the
  Worker's isolated Provider Home. Keep desktop-only window, notification, shortcut, and log
  controls explicitly labelled as local desktop settings.
- Make Remote Assets read only Worker packaged resources and Provider Home content, with canonical
  path fencing, bounded lists/content, read-only injection state, and no Local/Finder fallback.
- Reuse the shared session detail shell, metadata chips, composer, image workflow, and adapter-native
  runtime controls for Remote sessions. Carry bounded image attachments through the Remote send
  contract and fail explicitly where the protocol has no Remote equivalent.
- Enforce negotiated Remote attachment limits for MIME type, count, per-image bytes, and total
  bytes instead of applying the larger Local defaults.
- Keep Teams, Issues, Data, session totals, pending counts, and token-rate displays scoped to the
  selected Remote Core and fail closed when the source is offline or lacks the capability.
- Queue SSH requests above the negotiated Host concurrency limit, including reconnect admission,
  so normal page polling cannot turn an in-flight limit response into a misleading protocol
  incompatibility error.

## Validation

- Focused Electron suites: 25 files / 137 tests passed, including native SQLite composition.
- Final `pnpm test` — 890 files / 5,754 tests passed; 2 files / 3 tests skipped.
- `pnpm typecheck` passed architecture and Node/Web TypeScript checks.
- `pnpm build`
- `pnpm verify:linux-headless`
- `pnpm verify:macos-worker-sandbox`
- `git diff --check` passed; all modified production TypeScript files remain below 500 lines.
- Paired Claude/Codex deep review converged after bounded asset-scan, picker-policy, and
  source-identity follow-ups; all findings are recorded in
  `REVIEW_229_remote-worker-ui-authority.md`.

## Compatibility and recovery

Protocol 2.2 advertises the two Worker-node capabilities only after minor-version negotiation;
2.0/2.1 clients retain their established capability surface. Remote Hook and asset operations are
fenced to Worker-owned roots, while unsupported session actions remain visibly unavailable rather
than falling back to Local state. SSH request queuing is client-local and bounded.
