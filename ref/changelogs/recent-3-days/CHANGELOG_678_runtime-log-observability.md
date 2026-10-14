---
changelog_id: 678
changed_at: 2026-10-14
---

# Runtime log observability and retention

## Summary

Desktop, Core/Worker, and Relay logs now distinguish expected background behavior from faults,
preserve safe timing evidence, and bound managed macOS Worker log growth. This follows the
runtime investigation in REVIEW_323 and the owner's authorization to implement its logging work.

## Changes

- Desktop slow but successful summaries use info severity and an anonymous correlation reference.
  Actual failures remain warnings. File logging suppresses expected remote `service_stopped`
  errors only after shutdown begins; unexpected loss while running stays visible.
- Core/Worker default diagnostics emit UTC JSON records with fixed event categories, allowlisted
  metrics/error codes, and anonymous run-scoped references. Raw provider text, nested payloads,
  private paths, prompts, and credentials are excluded. Provider logging preserves safe details;
  debug remains silent. Repeats aggregate within one minute in a bounded 256-entry map.
- SSH timeout records include ping write completion/delay, recent receive age, queued bytes/frames,
  timer lag, and generation. Observer failures cannot change reconnect behavior. Relay records
  Worker attachment, disconnection, lease expiry/recovery timing, and forwarding failures without
  logging healthy heartbeat traffic or inspecting payloads. Protocol thresholds are unchanged.
- Managed macOS Worker stdout/stderr each retain a 10 MiB active file and three rolling backups.
  Existing content is copied to a separate `.legacy` file before first truncation. Copy/truncate
  preserves launchd's descriptor inode. Ownership, file mode, symlink, hardlink, and descriptor
  checks protect the managed files; failed rotation leaves active data available for retry.
- A dependency-free CJS bootstrap installs retention before importing the Worker ESM bundle.
  Startup failures become bounded category records, with repeat counts persisted across launchd
  restarts. The same Worker process/PID is retained. Interactive output and Linux journal retention
  keep their existing lifecycle. A retention failure reports a fixed warning and preserves output.

## Validation

- `pnpm typecheck` passed, including architecture and Core Node-boundary checks.
- Full `pnpm test`: 7,217 passed, 6 skipped; 1,154 passing files and 3 skipped files.
- `pnpm build` passed. `pnpm build:linux-headless` passed both reproducibility builds and the
  isolated Worker/Feishu bundle checks for all 11 roles.
- The built Worker entrypoint plus both bootstrap files loaded from an isolated temporary
  directory without checkout dependencies. Invalid synthetic config failed before service startup
  and produced only the expected structured category.
- Shell/CJS syntax, diff whitespace, file sizes, packaging resource mapping, and generated artifacts
  were checked. No personal home prefix was found in the generated JS/maps/JSON/HTML.

## Do Not Split Protection

None required: all 26 implementation/documentation scope files are at most 500 lines. Heartbeat
composition is a leaf helper and Relay observation is a small subclass; their existing facades
remain below the guardrail.

## Activation and limits

Source changes are complete. The installed app, managed Worker, live logs, and remote Relay were
not modified or restarted. Each affected component must load the new release after its lifecycle
action is authorized. This work improves evidence and retention; it does not establish or remove
the reported other-machine Claude delay or the remaining historical heartbeat causes.

See `REVIEW_324_runtime-log-observability.md` under `ref/reviews/recent-3-days/` for safety details and residual limits, and
`PLAN_89_runtime-log-observability.md` under `ref/plans/recent-3-days/` for the completed plan.
